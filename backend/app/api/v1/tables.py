"""Table management API endpoints."""
from typing import Any

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field

from app.middleware import get_current_user
from app.services.proxysql import proxysql_service
from app.services.schema_service import schema_service
from app.utils.db_helpers import get_proxysql_credentials
from app.utils.helpers import quote_ident

router = APIRouter()


# Row-level DML payloads.
#
# These are declared as explicit models rather than bare ``dict`` parameters:
# FastAPI treats a lone ``dict`` body parameter as the entire body but embeds
# each one under its own key as soon as a second body parameter appears. Relying
# on that implicit switch made the update/delete contract ambiguous, so every
# endpoint now takes one wrapper model with named fields.
class RowInsertRequest(BaseModel):
    """Body for inserting a config-table row."""

    data: dict[str, Any] = Field(..., description="Column name -> value map.")


class RowUpdateRequest(BaseModel):
    """Body for updating a single config-table row."""

    pk_values: dict[str, Any] = Field(
        ..., description="Primary-key column -> value map identifying the row."
    )
    data: dict[str, Any] = Field(..., description="Columns to update.")


class RowDeleteRequest(BaseModel):
    """Body for deleting a single config-table row."""

    pk_values: dict[str, Any] = Field(
        ..., description="Primary-key column -> value map identifying the row."
    )


# 临时调试：捕获所有异常并返回详细信息
@router.on_event("startup")
async def startup():
    import logging
    logging.basicConfig(level=logging.DEBUG)

# ---------------------------------------------------------------------------
# ProxySQL table discovery uses SHOW DATABASES + SHOW TABLES FROM <database>.
#
# ProxySQL uses SQLite internally and ATTACHes several databases:
#   main         – working config (MEMORY) + runtime_* tables (RUNTIME) +
#                  some stats_* / history_* tables
#   disk         – persistent on-disk config copies
#   monitor      – monitoring data (ping logs, connect logs, etc.)
#   stats        – enhanced stats (ProxySQL 2.x+, may not always be present)
#   stats_history– historical stats snapshots (ProxySQL 2.x+)
#
# Our browser shows layers (groups):
#   DISK         → tables from disk database
#   MEMORY       → config tables from main (without runtime_ prefix)
#   RUNTIME      → runtime_* tables from main
#   STATS        → stats_ / history_ tables from main + tables from stats db
#   MONITOR      → tables from monitor database (NEW)
#   STATS_HISTORY→ tables from stats_history database (if present)
#   [other]      → any other attached database shows as its own group
#
# The response includes a *table_db* dictionary mapping each table name
# to its SQLite database so that get_table_data can query the correct db.
# ---------------------------------------------------------------------------

# Special system tables to hide from the browser.
_HIDDEN_TABLES = {
    "sqlite_master", "sqlite_sequence", "sqlite_stat1",
    "sqlite_stat2", "sqlite_stat3", "sqlite_stat4",
    "scheduler",  # appears as a table in ProxySQL but is managed differently
}

# Databases whose tables go into a named layer 1:1.
# main is handled separately (split into memory / runtime / stats).
_DB_DIRECT_LAYERS = {
    "disk":          "disk",
    "monitor":       "monitor",
    "stats_history": "stats_history",
}

# Default group display order (first groups shown first).
_GROUP_ORDER = ["disk", "memory", "runtime", "stats", "monitor", "stats_history"]

# Per-layer database fallback (used when table_db lookup is unavailable).
_LAYER_DATABASE = {
    "disk":          "disk",
    "memory":        "main",
    "runtime":       "main",
    "stats":         "main",
    "monitor":       "monitor",
    "stats_history": "stats_history",
}


def _fetch_table_names(rows: list[dict]) -> list[str]:
    """Extract table names from SHOW TABLES result rows.

    ProxySQL returns column "tables" (SQLite3_Server.cpp rewrites SHOW TABLES
    as SELECT name AS tables FROM sqlite_master).  We also tolerate "name"
    for compatibility with test mocks.
    """
    return [r.get("tables") or r.get("name") or list(r.values())[0] for r in rows]


def _fetch_db_names(rows: list[dict]) -> list[str]:
    """Extract database names from SHOW DATABASES result rows."""
    return [r.get("name") or r.get("Database") or list(r.values())[0] for r in rows]


@router.get("/{server_id}/tables")
async def list_tables(
    server_id: str,
    user=Depends(get_current_user),
):
    """List all tables for a ProxySQL server, grouped by layer.

    Discovery strategy (same approach as proxyweb):
      1. SHOW DATABASES → discover all attached SQLite databases
      2. For each database, SHOW TABLES FROM <db>
      3. Classify into layers:
         - disk tables → disk group
         - main tables → memory / runtime / stats groups (by prefix)
         - monitor tables → monitor group
         - stats tables → stats group (merged)
         - stats_history tables → stats_history group
         - any other db → its own named group
    """
    try:
        host, port, admin_user, password = await get_proxysql_credentials(server_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取服务器凭证失败: {type(e).__name__}: {e}")

    groups: dict[str, list[str]] = {}
    table_db: dict[str, str] = {}  # table_name → database

    # ── Step 1: get all databases ──────────────────────────────────────
    try:
        rows_dbs = await proxysql_service.execute_query(
            host, port, admin_user, password, "SHOW DATABASES"
        )
        databases = _fetch_db_names(rows_dbs)
    except Exception:
        # Fallback for older ProxySQL that doesn't support SHOW DATABASES.
        databases = ["main"]

    # ── Step 2: discover tables per database ──────────────────────────
    for db in databases:
        if db in ("information_schema",):
            continue
        try:
            safe_db = quote_ident(db)
            rows_tables = await proxysql_service.execute_query(
                host, port, admin_user, password, f"SHOW TABLES FROM {safe_db}"
            )
        except Exception:
            continue

        for name in _fetch_table_names(rows_tables):
            if name in _HIDDEN_TABLES:
                continue

            if db == "main":
                # Split main tables into memory / runtime / stats by prefix.
                # NOTE: We intentionally do NOT set table_db for main-database
                # tables — the frontend already knows that memory / runtime /
                # stats layers always map to the "main" database via its
                # built-in layer→database fallback in dbForTable().  Setting
                # table_db here would be harmless for main-only tables, but it
                # would be overwritten later when processing the "disk" database
                # (which has the same table names), breaking runtime-layer
                # queries (disk.runtime_<table> does not exist).
                if name.startswith("runtime_"):
                    display = name[len("runtime_"):]
                    groups.setdefault("runtime", []).append(display)
                elif name.startswith("stats_") or name.startswith("history_"):
                    groups.setdefault("stats", []).append(name)
                else:
                    groups.setdefault("memory", []).append(name)
            elif db in _DB_DIRECT_LAYERS:
                layer = _DB_DIRECT_LAYERS[db]
                groups.setdefault(layer, []).append(name)
                # No table_db entry needed — the frontend's dbForTable()
                # fallback already maps disk→"disk", monitor→"monitor",
                # stats_history→"stats_history".
            else:
                # Unknown database — show as its own group.
                # Only here do we need a table_db entry, because the frontend
                # has no built-in fallback for custom database names.
                groups.setdefault(db, []).append(name)
                table_db[name] = db

    # ── Step 3: sort and order ────────────────────────────────────────
    for layer in groups:
        groups[layer].sort()

    # Order groups according to _GROUP_ORDER; any unknown groups follow.
    ordered_groups: dict[str, list[str]] = {}
    for key in _GROUP_ORDER:
        if key in groups:
            ordered_groups[key] = groups.pop(key)
    ordered_groups.update(sorted(groups.items()))  # remaining groups alphabetically

    return {
        "server_id": server_id,
        "groups": ordered_groups,
        "table_db": table_db,
    }


@router.get("/{server_id}/tables/{table_name}")
async def get_table_data(
    server_id: str,
    table_name: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    search: str = Query(None),
    order_by: str = Query(None),
    order_dir: str = Query("asc"),
    layer: str = Query("memory"),
    database: str = Query(None),
    user=Depends(get_current_user),
):
    """Get table data with pagination.

    The *layer* + *database* query parameters determine which SQLite
    database to query and whether the runtime_ prefix is needed:

      layer          database   full reference
      ─────────      ────────   ───────────────────
      memory         main       main.<table>
      runtime        main       main.runtime_<table>
      disk           disk       disk.<table>
      stats          main       main.<table>
      monitor        monitor    monitor.<table>
      stats_history  stats_hist stats_history.<table>
      [other]        [other]    [other].<table>

    When *database* is provided it takes precedence; otherwise the
    layer-to-database mapping (_LAYER_DATABASE) is used as fallback.
    """
    host, port, admin_user, password = await get_proxysql_credentials(server_id)

    # Resolve the database and full table reference.
    db = database or _LAYER_DATABASE.get(layer, "main")
    if layer == "runtime":
        full_table = f"{db}.runtime_{table_name}"
    else:
        full_table = f"{db}.{table_name}"

    # Validate both the database alias and table name.
    # For the runtime layer we need to construct the full runtime-prefixed
    # table name INSIDE the identifier quoting so that the resulting SQL is
    # valid: `main`.`runtime_mysql_servers` instead of `main`.runtime_`mysql_servers`.
    try:
        safe_db = quote_ident(db)
        safe_table = quote_ident(table_name)
        if layer == "runtime":
            runtime_table_name = f"runtime_{table_name}"
            safe_full = f"{safe_db}.{quote_ident(runtime_table_name)}"
        else:
            safe_full = f"{safe_db}.{safe_table}"
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid table name: {e}")

    # Get columns via PRAGMA (always against the correct database).
    # PRAGMA queries use unquoted identifiers because ProxySQL's SQLite
    # engine does not accept backtick-quoted arguments in PRAGMA statements.
    # For the runtime layer, the actual table name includes the "runtime_" prefix.
    try:
        pragma_target = f"runtime_{table_name}" if layer == "runtime" else table_name
        columns_result = await proxysql_service.execute_query(
            host, port, admin_user, password,
            f"PRAGMA table_info({pragma_target})"
        )
    except Exception:
        columns_result = []

    # Get total count
    count_sql = f"SELECT COUNT(*) as cnt FROM {safe_full}"
    count_result = await proxysql_service.execute_query(host, port, admin_user, password, count_sql)
    total = count_result[0]["cnt"] if count_result else 0

    # Build SELECT query
    query_sql = f"SELECT * FROM {safe_full}"

    # Search filter
    if search and columns_result:
        search_cols = []
        for c in columns_result:
            try:
                search_cols.append(f"CAST({quote_ident(c['name'])} AS TEXT) LIKE %s")
            except ValueError:
                continue
        if search_cols:
            query_sql += " WHERE " + " OR ".join(search_cols)

    # Ordering
    if order_by:
        try:
            safe_order_col = quote_ident(order_by)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Invalid order_by: {e}")
        dir_clause = "DESC" if order_dir.lower() == "desc" else "ASC"
        query_sql += f" ORDER BY {safe_order_col} {dir_clause}"

    # Pagination
    offset = (page - 1) * page_size
    query_sql += f" LIMIT {page_size} OFFSET {offset}"

    # Execute with search params
    param_count = query_sql.count("%s") if search and columns_result else 0
    params = [f"%{search}%"] * param_count if param_count > 0 else None
    rows = await proxysql_service.execute_query(host, port, admin_user, password, query_sql, params)

    column_names = [c["name"] for c in columns_result] if columns_result else []

    return {
        "table": table_name,
        "total": total,
        "page": page,
        "page_size": page_size,
        "column_names": column_names,
        "rows": rows,
    }


@router.get("/{server_id}/tables/{table_name}/schema")
async def get_table_schema(
    server_id: str,
    table_name: str,
    database: str = Query("main"),
    user=Depends(get_current_user),
):
    """Get table schema information."""
    host, port, admin_user, password = await get_proxysql_credentials(server_id)
    return await schema_service.get_table_schema(host, port, admin_user, password, database, table_name)


@router.post("/{server_id}/tables/{table_name}/row")
async def insert_row(
    server_id: str,
    table_name: str,
    payload: RowInsertRequest,
    user=Depends(get_current_user),
):
    """Insert a row into a config table (MEMORY layer)."""
    host, port, admin_user, password = await get_proxysql_credentials(server_id)

    data = payload.data
    if not data:
        raise HTTPException(status_code=400, detail="data must not be empty")

    # Validate every column name against the identifier whitelist to prevent
    # SQL injection through user-supplied dict keys.
    try:
        safe_table = quote_ident(table_name)
        quoted_cols = [quote_ident(c) for c in data.keys()]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid identifier: {e}")

    values = list(data.values())
    placeholders = ", ".join(["%s"] * len(values))
    cols_str = ", ".join(quoted_cols)

    sql = f"INSERT INTO main.{safe_table} ({cols_str}) VALUES ({placeholders})"
    affected = await proxysql_service.execute_modify(host, port, admin_user, password, sql, values)

    return {"ok": True, "affected_rows": affected}


@router.put("/{server_id}/tables/{table_name}/row")
async def update_row(
    server_id: str,
    table_name: str,
    payload: RowUpdateRequest,
    user=Depends(get_current_user),
):
    """Update a single row in a config table (MEMORY layer)."""
    host, port, admin_user, password = await get_proxysql_credentials(server_id)

    data = payload.data
    pk_values = payload.pk_values
    if not data:
        raise HTTPException(status_code=400, detail="data must not be empty")
    # An empty WHERE clause would rewrite every row in the table.
    if not pk_values:
        raise HTTPException(
            status_code=400,
            detail="pk_values must not be empty, otherwise every row would be updated",
        )

    try:
        safe_table = quote_ident(table_name)
        # Build SET clause (column names validated + quoted)
        set_clauses = [f"{quote_ident(col)} = %s" for col in data.keys()]
        # Build WHERE clause from primary key (column names validated + quoted)
        where_clauses = [f"{quote_ident(col)} = %s" for col in pk_values.keys()]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid identifier: {e}")

    set_values = list(data.values())
    where_values = list(pk_values.values())

    sql = f"UPDATE main.{safe_table} SET {', '.join(set_clauses)} WHERE {' AND '.join(where_clauses)}"
    affected = await proxysql_service.execute_modify(
        host, port, admin_user, password, sql, set_values + where_values
    )

    return {"ok": True, "affected_rows": affected}


@router.delete("/{server_id}/tables/{table_name}/row")
async def delete_row(
    server_id: str,
    table_name: str,
    payload: RowDeleteRequest,
    user=Depends(get_current_user),
):
    """Delete a single row from a config table (MEMORY layer)."""
    host, port, admin_user, password = await get_proxysql_credentials(server_id)

    pk_values = payload.pk_values
    # An empty WHERE clause would wipe the whole table.
    if not pk_values:
        raise HTTPException(
            status_code=400,
            detail="pk_values must not be empty, otherwise every row would be deleted",
        )

    try:
        safe_table = quote_ident(table_name)
        where_clauses = [f"{quote_ident(col)} = %s" for col in pk_values.keys()]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid identifier: {e}")

    where_values = list(pk_values.values())

    sql = f"DELETE FROM main.{safe_table} WHERE {' AND '.join(where_clauses)}"
    affected = await proxysql_service.execute_modify(
        host, port, admin_user, password, sql, where_values
    )

    return {"ok": True, "affected_rows": affected}
