"""Configuration diff API endpoints.

Compares Disk / Memory / Runtime layers of ProxySQL configuration tables
and returns row-level differences (Git-style +/~/- indicators).

Results are cached server-side for 60s.
Cache is invalidated on sync operations (apply/save/discard/load).
"""
import logging
from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional

from app.middleware import get_current_user
from app.schemas.config_diff import ConfigDiffResponse
from app.schemas.response import RESPONSE_AUTH, RESPONSE_500, HTTPError
from app.services.cache_service import cache_service
from app.services.layer_compare import normalize_rows, runtime_table_missing
from app.services.proxysql import proxysql_service
from app.utils.db_helpers import get_proxysql_credentials
from app.utils.helpers import row_hash

router = APIRouter(tags=["Config Diff"])
logger = logging.getLogger(__name__)

# Table prefixes that participate in config sync
_SYNC_TABLE_PREFIXES = [
    "mysql_", "pgsql_", "admin_", "proxysql_",
    "mysql_galera_", "mysql_group_replication_",
    "mysql_replication_", "scheduler", "restapi",
]


@router.get(
    "/{server_id}",
    response_model=ConfigDiffResponse,
    responses={
        200: {"description": "Config diff retrieved successfully."},
        500: {"description": "ProxySQL connection error.", "model": HTTPError},
        **RESPONSE_AUTH,
    },
    summary="Get config diff",
    description="Compare Memory and Runtime layers for all (or a specific) "
                "config table. Returns per-table row-level differences "
                "(added, removed, unchanged). Results cached for 60s.",
)
async def get_config_diff(
    server_id: str,
    table: Optional[str] = Query(
        None,
        description="Specific table to diff. If omitted, all synced tables are compared.",
        examples=["mysql_servers"],
    ),
    user=Depends(get_current_user),
):
    """Get configuration differences across Disk / Memory / Runtime layers.

    For each config table, returns:
    - Memory rows count
    - Runtime rows count
    - Rows only in Memory (not yet applied)
    - Rows only in Runtime (removed from Memory but still running)
    - Rows that differ (modified)
    """
    # Try cache first
    cached = cache_service.get_config_diff(server_id, table)
    if cached is not None:
        return cached

    host, port, admin_user, password = await get_proxysql_credentials(server_id)

    # Determine which tables to diff
    if table:
        tables_to_diff = [table]
    else:
        rows = await proxysql_service.execute_query(
            host, port, admin_user, password, "SHOW TABLES FROM main"
        )
        all_names = [r.get("tables") or r.get("name") or list(r.values())[0] for r in rows]
        tables_to_diff = [
            n for n in all_names
            if any(n.startswith(p) for p in _SYNC_TABLE_PREFIXES)
            and not n.startswith("runtime_")
            and not n.startswith("disk.")
        ]

    results = []
    for tbl in tables_to_diff:
        try:
            memory_rows = await proxysql_service.execute_query(
                host, port, admin_user, password, f"SELECT * FROM main.{tbl}"
            )
        except Exception:
            memory_rows = []

        try:
            runtime_rows = await proxysql_service.execute_query(
                host, port, admin_user, password, f"SELECT * FROM main.runtime_{tbl}"
            )
        except Exception:
            runtime_rows = []

        mem_hashes = {row_hash(r): r for r in normalize_rows(tbl, memory_rows)}
        run_hashes = {row_hash(r): r for r in normalize_rows(tbl, runtime_rows)}

        only_memory_keys = set(mem_hashes.keys()) - set(run_hashes.keys())
        only_runtime_keys = set(run_hashes.keys()) - set(mem_hashes.keys())
        common_keys = set(mem_hashes.keys()) & set(run_hashes.keys())

        # Static tables (no runtime counterpart) are always considered in sync;
        # see app.services.layer_compare for the rationale.
        applicable = not runtime_table_missing(tbl)
        has_diff = applicable and bool(only_memory_keys or only_runtime_keys)

        results.append({
            "table": tbl,
            "in_sync": not has_diff,
            "applicable": applicable,
            "memory_rows": len(memory_rows),
            "runtime_rows": len(runtime_rows),
            "only_in_memory": len(only_memory_keys) if has_diff else 0,
            "only_in_runtime": len(only_runtime_keys) if has_diff else 0,
            "diff": {
                "added": [mem_hashes[k] for k in only_memory_keys] if has_diff else [],
                "removed": [run_hashes[k] for k in only_runtime_keys] if has_diff else [],
                "unchanged": len(common_keys),
            } if has_diff else None,
        })

    result = {
        "server_id": server_id,
        "tables": results,
        "total_tables": len(results),
        "total_out_of_sync": sum(1 for r in results if not r["in_sync"]),
    }

    # Store in cache
    cache_service.set_config_diff(server_id, table, result)

    return result
