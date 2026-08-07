"""ProxySQL configuration backup and restore service.

Provides snapshot-based backup: exports all ProxySQL config tables
from MEMORY layer as JSON, stores them in the local SQLite database,
and can restore them back to the target instance.
"""
import json
from datetime import datetime, timezone
from typing import Optional

from app.database import get_db
from app.services.proxysql import proxysql_service
from app.services.sync_service import sync_service


class BackupService:
    """Manages configuration backups (export/restore) for ProxySQL instances."""

    async def create_backup(
        self,
        server_id: str,
        user_id: int,
        host: str,
        port: int,
        user: str,
        password: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> dict:
        """Export all config tables from MEMORY layer and store as a backup.

        Returns:
            dict with backup metadata (id, name, table_count, row_count, size_bytes).
        """
        # Discover all MEMORY tables
        rows = await proxysql_service.execute_query(
            host, port, user, password, "SHOW TABLES FROM main"
        )
        all_names = [r.get("tables") or r.get("name") or list(r.values())[0] for r in rows]
        table_names = [
            n for n in all_names
            if any(n.startswith(p) for p in sync_service.SYNC_TABLE_PREFIXES)
            and not n.startswith("runtime_")
        ]

        # Export each table's data
        snapshot: dict[str, list[dict]] = {}
        total_rows = 0

        for table in table_names:
            try:
                data = await proxysql_service.execute_query(
                    host, port, user, password, f"SELECT * FROM main.{table}"
                )
                snapshot[table] = [dict(r) for r in data]
                total_rows += len(data)
            except Exception:
                # Skip tables that fail to read (e.g. disk-only tables)
                continue

        backup_json = json.dumps(snapshot, default=str)
        size_bytes = len(backup_json.encode("utf-8"))
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        auto_name = name or f"Backup-{ts}"

        db = await get_db()
        try:
            cursor = await db.execute(
                """INSERT INTO config_backups
                   (server_id, user_id, name, description, backup_data, table_count, row_count, size_bytes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (server_id, user_id, auto_name, description or "", backup_json, len(snapshot), total_rows, size_bytes),
            )
            await db.commit()
            backup_id = cursor.lastrowid
        finally:
            await db.close()

        return {
            "id": backup_id,
            "server_id": server_id,
            "name": auto_name,
            "description": description or "",
            "table_count": len(snapshot),
            "row_count": total_rows,
            "size_bytes": size_bytes,
            "created_at": ts,
        }

    async def list_backups(self, server_id: str) -> list[dict]:
        """List all backups for a server."""
        db = await get_db()
        try:
            cursor = await db.execute(
                """SELECT cb.id, cb.server_id, cb.user_id, cb.name, cb.description,
                          cb.table_count, cb.row_count, cb.size_bytes, cb.created_at,
                          COALESCE(u.username, 'unknown') AS created_by
                   FROM config_backups cb
                   LEFT JOIN users u ON cb.user_id = u.id
                   WHERE cb.server_id = ?
                   ORDER BY cb.created_at DESC""",
                (server_id,),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
        finally:
            await db.close()

    async def get_backup(self, backup_id: int) -> Optional[dict]:
        """Get a specific backup including data."""
        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT * FROM config_backups WHERE id = ?",
                (backup_id,),
            )
            row = await cursor.fetchone()
            return dict(row) if row else None
        finally:
            await db.close()

    async def delete_backup(self, backup_id: int) -> bool:
        """Delete a backup by ID."""
        db = await get_db()
        try:
            cursor = await db.execute(
                "DELETE FROM config_backups WHERE id = ?",
                (backup_id,),
            )
            await db.commit()
            return cursor.rowcount > 0
        finally:
            await db.close()

    async def download_backup(self, backup_id: int) -> Optional[tuple[str, str]]:
        """Get backup JSON data for download.

        Returns:
            (file_name, json_string) or None if not found.
        """
        backup = await self.get_backup(backup_id)
        if not backup:
            return None
        safe_name = backup["name"].replace(" ", "_").replace("/", "_")
        return f"{safe_name}.json", backup["backup_data"]

    async def restore_backup(
        self,
        backup_id: int,
        host: str,
        port: int,
        user: str,
        password: str,
        table_filter: Optional[list[str]] = None,
    ) -> dict:
        """Restore configuration from a backup to the target ProxySQL instance.

        Writes table data to MEMORY layer. Caller should apply/save separately.
        """
        backup = await self.get_backup(backup_id)
        if not backup:
            raise ValueError(f"Backup {backup_id} not found")

        snapshot: dict = json.loads(backup["backup_data"])
        tables = table_filter or list(snapshot.keys())

        results = []
        for table in tables:
            if table not in snapshot:
                results.append({"table": table, "success": False, "error": "Not in backup"})
                continue

            rows = snapshot[table]
            if not rows:
                results.append({"table": table, "success": True, "rows_restored": 0})
                continue

            try:
                # Delete existing data in MEMORY for this table
                await proxysql_service.execute_modify(
                    host, port, user, password,
                    f"DELETE FROM main.{table}"
                )
                # Build batch INSERT
                columns = list(rows[0].keys())
                col_list = ", ".join(columns)
                placeholders = ", ".join(["?" for _ in columns])
                values = [
                    tuple(row.get(c) for c in columns)
                    for row in rows
                ]
                # Execute in batches to avoid overly large statements
                BATCH_SIZE = 100
                for i in range(0, len(values), BATCH_SIZE):
                    batch = values[i:i + BATCH_SIZE]
                    placeholders_batch = ", ".join([f"({placeholders})" for _ in batch])
                    flat_values = [v for row in batch for v in row]
                    await proxysql_service.execute_modify(
                        host, port, user, password,
                        f"INSERT INTO main.{table} ({col_list}) VALUES {placeholders_batch}",
                        flat_values,
                    )
                results.append({"table": table, "success": True, "rows_restored": len(rows)})
            except Exception as e:
                results.append({"table": table, "success": False, "error": str(e)})

        return {
            "backup_id": backup_id,
            "backup_name": backup["name"],
            "results": results,
            "total": len(results),
            "succeeded": sum(1 for r in results if r["success"]),
            "failed": sum(1 for r in results if not r["success"]),
        }

    async def delete_backups(self, backup_ids: list[int]) -> int:
        """Batch-delete multiple backups.

        Returns:
            Number of backups actually deleted.
        """
        if not backup_ids:
            return 0
        db = await get_db()
        try:
            placeholders = ", ".join(["?" for _ in backup_ids])
            cursor = await db.execute(
                f"DELETE FROM config_backups WHERE id IN ({placeholders})",
                backup_ids,
            )
            await db.commit()
            return cursor.rowcount
        finally:
            await db.close()

    async def create_backups_for_servers(
        self,
        server_ids: list[str],
        user_id: int,
        name_prefix: Optional[str] = None,
    ) -> list[dict]:
        """Create backups for multiple servers in one call.

        Returns:
            List of result dicts, one per server (including failures).
        """
        from app.utils.db_helpers import get_proxysql_credentials

        results = []
        for sid in server_ids:
            try:
                host, port, admin_user, password = await get_proxysql_credentials(sid)
                prefix = name_prefix or f"Batch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
                result = await self.create_backup(
                    server_id=sid,
                    user_id=user_id,
                    host=host,
                    port=port,
                    user=admin_user,
                    password=password,
                    name=f"{prefix}-{sid[:8]}",
                )
                results.append({"server_id": sid, "success": True, "backup": result})
            except Exception as e:
                results.append({"server_id": sid, "success": False, "error": str(e)})

        return results


backup_service = BackupService()
