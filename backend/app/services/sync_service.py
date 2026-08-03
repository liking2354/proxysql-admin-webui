"""ProxySQL three-layer configuration sync service.

DISK <-- SAVE -- MEMORY -- APPLY --> RUNTIME
       -- LOAD -->        <-- DISCARD --
"""
import logging
from enum import Enum
from typing import Optional

from app.services.proxysql import proxysql_service
from app.services.layer_compare import compare_layers, normalize_rows
from app.utils.helpers import row_hash

logger = logging.getLogger(__name__)


class SyncAction(str, Enum):
    APPLY = "apply"       # MEMORY -> RUNTIME
    SAVE = "save"         # MEMORY -> DISK
    DISCARD = "discard"   # RUNTIME -> MEMORY
    LOAD = "load"         # DISK -> MEMORY


class SyncService:
    """Manages ProxySQL three-layer configuration synchronization."""

    # Table prefixes that participate in sync
    SYNC_TABLE_PREFIXES = [
        "mysql_", "pgsql_", "admin_", "proxysql_",
        "mysql_galera_", "mysql_group_replication_",
        "mysql_replication_", "scheduler", "restapi",
    ]

    # Module to LOAD/SAVE command mapping
    # Only tables that correspond to independent LOAD/SAVE modules are listed.
    # Sub-tables (e.g., mysql_collations, mysql_firewall_*) are handled
    # implicitly by their parent module commands and are silently skipped here.
    CONFIG_MODULES = {
        "mysql_servers": "MYSQL SERVERS",
        "mysql_users": "MYSQL USERS",
        "mysql_query_rules": "MYSQL QUERY RULES",
        "mysql_variables": "MYSQL VARIABLES",
        "admin_variables": "ADMIN VARIABLES",
        "pgsql_servers": "PGSQL SERVERS",
        "pgsql_users": "PGSQL USERS",
        "pgsql_query_rules": "PGSQL QUERY RULES",
        "pgsql_variables": "PGSQL VARIABLES",
        "proxysql_servers": "PROXYSQL SERVERS",
        "scheduler": "SCHEDULER",
    }
    # Tables that are implicitly synced by their parent module (no separate command).
    _SUB_TABLES = {
        "mysql_aws_aurora_hostgroups", "mysql_collations",
        "mysql_firewall_whitelist_rules", "mysql_firewall_whitelist_sqli_fingerprints",
        "mysql_firewall_whitelist_users", "mysql_galera_hostgroups",
        "mysql_group_replication_hostgroups", "mysql_hostgroup_attributes",
        "mysql_query_rules_fast_routing", "mysql_replication_hostgroups",
        "mysql_servers_ssl_params", "pgsql_firewall_whitelist_rules",
        "pgsql_firewall_whitelist_sqli_fingerprints", "pgsql_firewall_whitelist_users",
        "pgsql_hostgroup_attributes", "pgsql_ldap_mapping",
        "pgsql_query_rules_fast_routing", "pgsql_replication_hostgroups",
        "pgsql_servers_ssl_params", "restapi_routes",
    }

    async def get_sync_status(
        self,
        host: str, port: int, user: str, password: str,
    ) -> dict:
        """Get sync status for all config tables.

        Compares three layers:
        - MEMORY (main): Working configuration in memory
        - RUNTIME (runtime_*): Currently active configuration
        - DISK (disk.*): Persisted configuration on disk

        Status indicators:
        - has_unapplied: MEMORY differs from RUNTIME (needs LOAD to apply)
        - has_unsaved: MEMORY differs from DISK (needs SAVE to persist)
        """
        rows = await proxysql_service.execute_query(
            host, port, user, password, "SHOW TABLES FROM main"
        )
        # ProxySQL returns column "tables" (SELECT name AS tables FROM sqlite_master).
        all_names = [r.get("tables") or r.get("name") or list(r.values())[0] for r in rows]
        table_names = [
            n for n in all_names
            if any(n.startswith(p) for p in self.SYNC_TABLE_PREFIXES)
            and not n.startswith("runtime_")
        ]

        results = []
        for table in table_names:
            memory_rows = await proxysql_service.execute_query(
                host, port, user, password, f"SELECT * FROM main.{table}"
            )
            try:
                runtime_rows = await proxysql_service.execute_query(
                    host, port, user, password, f"SELECT * FROM main.runtime_{table}"
                )
            except Exception:
                runtime_rows = []

            # Check DISK layer for unsaved changes
            disk_rows = []
            try:
                disk_rows = await proxysql_service.execute_query(
                    host, port, user, password, f"SELECT * FROM disk.{table}"
                )
            except Exception:
                # disk table might not exist or be accessible
                disk_rows = []

            # Compute hashes for comparison.
            # Comparison is delegated to layer_compare so that both this service
            # and the config_diff endpoint apply the same normalisation rules
            # (see layer_compare for why naive row-set diffing over-reports).
            cmp = compare_layers(table, memory_rows, runtime_rows)
            has_unapplied = not cmp["in_sync"]
            only_memory = cmp["only_memory"]
            only_runtime = cmp["only_runtime"]

            # has_unsaved: MEMORY != DISK
            if not cmp["applicable"] or not disk_rows:
                has_unsaved = False
            else:
                mem_hashes = {row_hash(r) for r in normalize_rows(table, memory_rows)}
                disk_hashes = {row_hash(r) for r in normalize_rows(table, disk_rows)}
                has_unsaved = mem_hashes != disk_hashes

            results.append({
                "table": table,
                "has_unapplied": has_unapplied,
                "has_unsaved": has_unsaved,
                "applicable": cmp["applicable"],
                "memory_rows": len(memory_rows),
                "runtime_rows": len(runtime_rows),
                "disk_rows": len(disk_rows),
                "diff": {
                    "only_memory": only_memory,
                    "only_runtime": only_runtime,
                } if has_unapplied else None,
                "unsaved_diff": {
                    "disk_differs": has_unsaved,
                    "disk_rows": len(disk_rows),
                } if has_unsaved else None,
            })

        # Sub-tables (e.g. mysql_collations) are synced implicitly by their
        # parent module (e.g. MYSQL VARIABLES).  They have no independent LOAD
        # command and will *always* show as "unapplied" if the runtime layer is
        # empty or differs.  Excluding them from the total_unapplied count
        # prevents the UI from showing a permanently non-zero "pending" badge
        # that cannot be cleared by clicking "Apply All".
        #
        # Also exclude tables that have entries only in runtime (stale runtime
        # entries that survived through ProxySQL constraint protection).
        # These are reported with a `blocked` flag instead.
        unapplied_tables = [
            r for r in results
            if r["has_unapplied"]
            and r["table"] not in self._SUB_TABLES
        ]
        # Tables with unapplied changes that are "blocked" — runtime has
        # entries that cannot be removed via standard LOAD commands (e.g.
        # mysql_users with conflicting (username, frontend/backend) combos).
        blocked_tables = [
            r for r in unapplied_tables
            if r.get("diff") and r["diff"].get("only_runtime", 0) > 0
               and r.get("diff", {}).get("only_memory", 0) > 0
        ]

        return {
            "tables": results,
            "total_unapplied": len(unapplied_tables),
            "total_unsaved": sum(1 for r in results if r["has_unsaved"]),
            "total_blocked": len(blocked_tables),
            "blocked_tables": [r["table"] for r in blocked_tables],
        }

    async def sync_action(
        self,
        host: str, port: int, user: str, password: str,
        action: SyncAction,
        tables: Optional[list[str]] = None,
    ) -> dict:
        """Execute a sync action on specified tables."""
        sql_templates = {
            SyncAction.APPLY: "LOAD {module} TO RUNTIME",
            SyncAction.SAVE: "SAVE {module} TO DISK",
            SyncAction.DISCARD: "LOAD {module} FROM RUNTIME",
            SyncAction.LOAD: "LOAD {module} FROM DISK",
        }

        if tables is None:
            rows = await proxysql_service.execute_query(
                host, port, user, password, "SHOW TABLES FROM main"
            )
            # ProxySQL returns column "tables" (SELECT name AS tables FROM sqlite_master).
            all_names = [r.get("tables") or r.get("name") or list(r.values())[0] for r in rows]
            tables = [
                n for n in all_names
                if any(n.startswith(p) for p in self.SYNC_TABLE_PREFIXES)
                and not n.startswith("runtime_")
            ]

        results = []
        for table in tables:
            # Map table name to module name for LOAD/SAVE commands
            module = self.CONFIG_MODULES.get(table)
            if module is None:
                # Try without _ prefix variants
                for prefix in ["mysql_", "pgsql_", "admin_"]:
                    if table.startswith(prefix):
                        base = table[len(prefix):]
                        if base in self.CONFIG_MODULES:
                            module = self.CONFIG_MODULES[base]
                            break

            if module is None:
                if table in self._SUB_TABLES:
                    # Sub-tables are handled implicitly by parent module
                    results.append({"table": table, "success": True, "skipped": True})
                else:
                    results.append({"table": table, "success": False, "error": f"Unknown module for table: {table}"})
                continue

            sql = sql_templates[action].format(module=module)
            try:
                output = await proxysql_service.execute_admin_command(
                    host, port, user, password, sql
                )
                result_entry = {"table": table, "success": True, "output": output}

                # Post-apply verification: after LOAD {module} TO RUNTIME,
                # check whether the runtime layer actually matches memory.
                # ProxySQL may silently refuse to apply changes when unique
                # constraints or CHECK constraints on runtime tables would
                # be violated (e.g. mysql_users stuck with stale entries).
                if action == SyncAction.APPLY and table not in self._SUB_TABLES:
                    try:
                        memory_rows = await proxysql_service.execute_query(
                            host, port, user, password,
                            f"SELECT * FROM main.{table}"
                        )
                        runtime_rows = await proxysql_service.execute_query(
                            host, port, user, password,
                            f"SELECT * FROM main.runtime_{table}"
                        )
                        mem_hashes = {row_hash(r) for r in normalize_rows(table, memory_rows)}
                        run_hashes = {row_hash(r) for r in normalize_rows(table, runtime_rows)}
                        if mem_hashes != run_hashes:
                            only_mem = len(mem_hashes - run_hashes)
                            only_run = len(run_hashes - mem_hashes)
                            result_entry["applied"] = False
                            result_entry["warning"] = (
                                f"LOAD {module} TO RUNTIME completed but the runtime "
                                f"table still differs from memory "
                                f"(only_in_memory={only_mem}, only_in_runtime={only_run}). "
                                f"This may indicate stuck runtime entries that cannot be "
                                f"removed via standard LOAD — a ProxySQL restart or manual "
                                f"runtime reconciliation may be required."
                            )
                            logger.warning(
                                f"Post-apply mismatch for {table}: "
                                f"mem={len(mem_hashes)} run={len(run_hashes)} "
                                f"diff=+{only_mem}/-{only_run}"
                            )
                        else:
                            result_entry["applied"] = True
                    except Exception as verify_err:
                        result_entry["verification_error"] = str(verify_err)

                results.append(result_entry)
            except Exception as e:
                results.append({"table": table, "success": False, "error": str(e)})

        return {
            "action": action.value,
            "results": results,
            "total": len(results),
            "succeeded": sum(1 for r in results if r["success"]),
            "failed": sum(1 for r in results if not r["success"]),
            "really_applied": sum(1 for r in results if r.get("applied") is True),
            "warnings": [r for r in results if r.get("warning")],
        }

    async def reconcile_mysql_users_runtime(
        self,
        host: str, port: int, user: str, password: str,
    ) -> dict:
        """Fix stuck mysql_users runtime by splitting dual-purpose entries.

        When the memory layer has a single mysql_users row with both
        ``frontend=1`` AND ``backend=1``, but the runtime layer already
        contains *two* rows for the same username (one with frontend=1,
        one with backend=1), the standard ``LOAD MYSQL USERS TO RUNTIME``
        command fails silently because ProxySQL's runtime_mysql_users
        table has UNIQUE constraints on (username, frontend) and
        (username, backend), and it **does not allow DELETEs** from
        runtime tables (CHECK constraints further restrict column values
        to {0,1}, preventing temporary-value workarounds).

        Strategy:
            Split each memory row that has both frontend=1 AND backend=1
            into TWO rows with the SAME username:
                - frontend=1, backend=0   (client can authenticate)
                - frontend=0, backend=1   (ProxySQL can open backend conns)
            Both rows together are functionally equivalent to a single
            dual-purpose row because ProxySQL matches the same username
            for both directions independently.  The two rows must share
            identical passwords and attributes.

        .. note::

           This is a runtime-constraint workaround, NOT a user-separation
           mechanism.  ProxySQL always forwards the client's username to
           the backend MySQL — it never maps one username to another.
        """
        # Read current memory
        memory_rows = await proxysql_service.execute_query(
            host, port, user, password, "SELECT * FROM main.mysql_users"
        )

        # Find entries with both frontend=1 AND backend=1
        dual_purpose = [
            r for r in memory_rows
            if str(r.get("frontend", "0")) == "1"
            and str(r.get("backend", "0")) == "1"
        ]

        if not dual_purpose:
            return {
                "reconciled": False,
                "message": "No dual-purpose mysql_users entries found (frontend=1 AND backend=1). Nothing to reconcile.",
            }

        results = []
        for row in dual_purpose:
            username = row.get("username", "")
            # Build the frontend-only entry
            fe_row = dict(row)
            fe_row["backend"] = "0"
            # Build the backend-only entry
            be_row = dict(row)
            be_row["frontend"] = "0"

            # Delete the original dual-purpose row from memory
            try:
                cols = list(row.keys())
                vals = [str(row[c]) for c in cols]
                placeholders = ", ".join(["%s"] * len(cols))
                col_names = ", ".join(cols)
                # Build DELETE using all columns as identifiers
                where_clauses = " AND ".join([f"{c} = %s" for c in cols])
                await proxysql_service.execute_modify(
                    host, port, user, password,
                    f"DELETE FROM main.mysql_users WHERE {where_clauses}",
                    vals,
                )
                results.append({
                    "username": username,
                    "action": "deleted_original",
                    "success": True,
                })
            except Exception as e:
                results.append({
                    "username": username,
                    "action": "delete_original",
                    "success": False,
                    "error": str(e),
                })
                continue

            # Insert frontend-only entry
            try:
                fe_cols = list(fe_row.keys())
                fe_vals = [str(fe_row[c]) for c in fe_cols]
                fe_placeholders = ", ".join(["%s"] * len(fe_cols))
                fe_col_names = ", ".join(fe_cols)
                await proxysql_service.execute_modify(
                    host, port, user, password,
                    f"INSERT INTO main.mysql_users ({fe_col_names}) VALUES ({fe_placeholders})",
                    fe_vals,
                )
                results.append({
                    "username": username,
                    "action": "inserted_frontend",
                    "detail": "frontend=1 backend=0",
                    "success": True,
                })
            except Exception as e:
                results.append({
                    "username": username,
                    "action": "insert_frontend",
                    "success": False,
                    "error": str(e),
                })

            # Insert backend-only entry
            try:
                be_cols = list(be_row.keys())
                be_vals = [str(be_row[c]) for c in be_cols]
                be_placeholders = ", ".join(["%s"] * len(be_cols))
                be_col_names = ", ".join(be_cols)
                await proxysql_service.execute_modify(
                    host, port, user, password,
                    f"INSERT INTO main.mysql_users ({be_col_names}) VALUES ({be_placeholders})",
                    be_vals,
                )
                results.append({
                    "username": username,
                    "action": "inserted_backend",
                    "detail": "frontend=0 backend=1",
                    "success": True,
                })
            except Exception as e:
                results.append({
                    "username": username,
                    "action": "insert_backend",
                    "success": False,
                    "error": str(e),
                })

        # Now apply with LOAD MYSQL USERS TO RUNTIME
        apply_result = await self.sync_action(
            host, port, user, password,
            SyncAction.APPLY,
            tables=["mysql_users"],
        )

        return {
            "reconciled": True,
            "users_reconciled": [r["username"] for r in dual_purpose],
            "steps": results,
            "apply_result": apply_result,
        }


sync_service = SyncService()
