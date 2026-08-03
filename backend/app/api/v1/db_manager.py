"""Database Manager API — direct access to backend MySQL databases
that are registered in ProxySQL's mysql_servers table.

All backend MySQL servers are discovered from ProxySQL configuration.
The connection credentials come from:
- Host/Port: ProxySQL mysql_servers table
- Username/Password: ProxySQL mysql_users table (backend=1, active=1)

This is the correct approach because mysql_users stores the actual business
user credentials that ProxySQL uses to connect to backend MySQL instances
for query routing. The monitor user (mysql-monitor_*) only has minimal
permissions for health checks and is insufficient for database management.

Note on credentials scope: ProxySQL has no per-server credential columns in
mysql_servers. Every backend=1 user in mysql_users is used to connect to all
hostgroups, so any business user can access any backend. The default_hostgroup
column only controls routing of unmatched queries.

This module provides:
- List backend MySQL servers from ProxySQL config
- List available backend user credentials (from mysql_users)
- Test connectivity to a backend
- Browse databases, tables, schema
- Execute read/write SQL queries
"""

import asyncio
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.proxysql import proxysql_service
from app.services.mysql_client import mysql_backend_client
from app.utils.db_helpers import get_proxysql_credentials
from app.middleware import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/db-manager", tags=["Database Manager"])


# ── Pydantic models ──────────────────────────────────────────────

class BackendServer(BaseModel):
    """A backend MySQL server discovered from ProxySQL's mysql_servers."""
    hostgroup_id: int
    hostname: str
    port: int
    status: str
    weight: int
    compression: int
    max_connections: int
    max_replication_lag: int
    use_ssl: int
    max_latency_ms: int
    comment: str


class BackendUser(BaseModel):
    """A business user from ProxySQL's mysql_users table (backend=1)."""
    username: str
    default_hostgroup: int
    default_schema: str
    active: int
    max_connections: int
    comment: str


class BackendServerSummary(BaseModel):
    """Summary view of a backend server for the database manager."""
    id: str  # "{hostgroup_id}:{hostname}:{port}"
    hostgroup_id: int
    hostname: str
    port: int
    status: str
    comment: str
    available_users: list[BackendUser] = []  # business users that can connect to this backend


class ExecuteRequest(BaseModel):
    sql: str = Field(..., description="SQL statement to execute")
    database: Optional[str] = Field(None, description="Database to use (optional)")
    hostname: str = Field(..., description="Backend MySQL hostname")
    port: int = Field(3306, description="Backend MySQL port")
    username: str = Field(..., description="Business username from mysql_users")
    limit: int = Field(100, ge=1, le=5000, description="Max rows to return")


class ExecuteResponse(BaseModel):
    type: str  # "select", "modify", "error"
    rows: Optional[list[dict]] = None
    columns: Optional[list[str]] = None
    row_count: int = 0
    affected_rows: Optional[int] = None
    elapsed_ms: float = 0
    error: Optional[str] = None


class TableInfo(BaseModel):
    name: str
    rows_estimate: Optional[int] = None


class ColumnInfo(BaseModel):
    field: str
    type: str
    null: str
    key: str
    default: Optional[str]
    extra: str


class TableDataResponse(BaseModel):
    rows: list[dict]
    columns: list[str]
    total: int
    page: int
    page_size: int
    elapsed_ms: float


class TestConnectionResponse(BaseModel):
    success: bool
    version: Optional[str] = None
    server_time: Optional[str] = None
    error: Optional[str] = None
    elapsed_ms: float = 0


# ── Helper functions ─────────────────────────────────────────────

def _build_server_id(hostname: str, port: int, hostgroup_id: int) -> str:
    """Build a unique identifier for a backend server."""
    return f"{hostgroup_id}:{hostname}:{port}"


def _sanitize_identifier(name: str) -> bool:
    """Check if a database/table name is safe (alphanumeric, underscore, dash)."""
    return bool(re.match(r'^[a-zA-Z0-9_\-]+$', name))


# ── API Endpoints ────────────────────────────────────────────────

@router.get("/{server_id}/backends", response_model=list[BackendServerSummary])
async def list_backends(
    server_id: str,
    current_user: dict = Depends(get_current_user),
):
    """List all backend MySQL servers registered in ProxySQL's mysql_servers table,
    along with available business users from mysql_users.

    Each backend represents a MySQL instance that ProxySQL routes queries to.
    This is the entry point for the database manager — only servers that
    ProxySQL knows about can be managed.

    Business users (backend=1, active=1) are retrieved from mysql_users.
    These are the actual credentials ProxySQL uses to connect to backend
    MySQL instances, with proper read/write permissions — unlike the
    monitor user which only has minimal health-check privileges.
    """
    creds = await get_proxysql_credentials(server_id)

    try:
        backends = await proxysql_service.execute_query(
            creds[0], creds[1], creds[2], creds[3],
            "SELECT * FROM mysql_servers ORDER BY hostgroup_id, hostname, port",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query ProxySQL: {e}")

    # Get business users from mysql_users (backend=1, active=1)
    try:
        raw_users = await proxysql_service.execute_query(
            creds[0], creds[1], creds[2], creds[3],
            "SELECT username, default_hostgroup, default_schema, active, "
            "max_connections, comment "
            "FROM mysql_users WHERE backend=1 AND active=1 "
            "ORDER BY username",
        )
        business_users: list[BackendUser] = [
            BackendUser(
                username=str(u["username"]),
                default_hostgroup=int(u["default_hostgroup"]),
                default_schema=str(u.get("default_schema", "")),
                active=int(u["active"]),
                max_connections=int(u["max_connections"]),
                comment=str(u.get("comment", "")),
            )
            for u in raw_users
        ]
    except Exception:
        business_users = []

    # In ProxySQL, backend credentials are GLOBAL: every user in mysql_users
    # with backend=1 is used to connect to *all* hostgroups. The
    # default_hostgroup column only decides where unmatched queries are routed;
    # it does not restrict which backends the account may connect to (there is
    # no per-server credential column in mysql_servers).
    #
    # Therefore every backend server can be accessed with any backend user.
    # Users whose default_hostgroup matches the server's hostgroup are listed
    # first so the UI preselects the most natural choice.
    results = []
    seen = set()
    for b in backends:
        sid = _build_server_id(
            str(b["hostname"]), int(b["port"]), int(b["hostgroup_id"])
        )
        if sid in seen:
            continue
        seen.add(sid)
        hg = int(b["hostgroup_id"])
        ordered_users = sorted(
            business_users,
            key=lambda u: (u.default_hostgroup != hg, u.username),
        )
        results.append(BackendServerSummary(
            id=sid,
            hostgroup_id=hg,
            hostname=str(b["hostname"]),
            port=int(b["port"]),
            status=str(b.get("status", "ONLINE")),
            comment=str(b.get("comment", "")),
            available_users=ordered_users,
        ))

    return results


@router.post("/{server_id}/test-connection", response_model=TestConnectionResponse)
async def test_backend_connection(
    server_id: str,
    hostname: str = Query(..., description="Backend MySQL hostname"),
    port: int = Query(3306, description="Backend MySQL port"),
    username: str = Query(..., description="Business username from mysql_users"),
    current_user: dict = Depends(get_current_user),
):
    """Test direct connectivity to a backend MySQL server using a business user's
    credentials from ProxySQL's mysql_users table."""
    password = await _get_user_password(server_id, username)

    result = await mysql_backend_client.test_connection(
        hostname, port, username, password,
    )
    return TestConnectionResponse(**result)


@router.get("/{server_id}/databases")
async def list_databases(
    server_id: str,
    hostname: str = Query(..., description="Backend MySQL hostname"),
    port: int = Query(3306, description="Backend MySQL port"),
    username: str = Query(..., description="Business username from mysql_users"),
    current_user: dict = Depends(get_current_user),
):
    """List all databases on a backend MySQL server."""
    password = await _get_user_password(server_id, username)

    try:
        databases = await mysql_backend_client.get_databases(
            hostname, port, username, password,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection to backend timed out")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to list databases: {e}")

    return {"databases": databases}


@router.get("/{server_id}/tables")
async def list_tables(
    server_id: str,
    hostname: str = Query(..., description="Backend MySQL hostname"),
    port: int = Query(3306, description="Backend MySQL port"),
    database: str = Query(..., description="Database name"),
    username: str = Query(..., description="Business username from mysql_users"),
    current_user: dict = Depends(get_current_user),
):
    """List all tables in a database on a backend MySQL server."""
    if not _sanitize_identifier(database):
        raise HTTPException(status_code=400, detail="Invalid database name")

    password = await _get_user_password(server_id, username)

    try:
        tables = await mysql_backend_client.get_tables(
            hostname, port, username, password, database,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection to backend timed out")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to list tables: {e}")

    return {"database": database, "tables": tables}


@router.get("/{server_id}/table-schema")
async def get_table_schema(
    server_id: str,
    hostname: str = Query(..., description="Backend MySQL hostname"),
    port: int = Query(3306, description="Backend MySQL port"),
    database: str = Query(..., description="Database name"),
    table: str = Query(..., description="Table name"),
    username: str = Query(..., description="Business username from mysql_users"),
    current_user: dict = Depends(get_current_user),
):
    """Get the column schema for a table on a backend MySQL server."""
    if not _sanitize_identifier(database) or not _sanitize_identifier(table):
        raise HTTPException(status_code=400, detail="Invalid database or table name")

    password = await _get_user_password(server_id, username)

    try:
        columns = await mysql_backend_client.get_table_schema(
            hostname, port, username, password, database, table,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection to backend timed out")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to get schema: {e}")

    return {
        "database": database,
        "table": table,
        "columns": [
            {
                "field": str(c.get("Field", "")),
                "type": str(c.get("Type", "")),
                "null": str(c.get("Null", "")),
                "key": str(c.get("Key", "")),
                "default": str(c.get("Default", "")) if c.get("Default") is not None else None,
                "extra": str(c.get("Extra", "")),
            }
            for c in columns
        ],
    }


@router.get("/{server_id}/table-data", response_model=TableDataResponse)
async def get_table_data(
    server_id: str,
    hostname: str = Query(..., description="Backend MySQL hostname"),
    port: int = Query(3306, description="Backend MySQL port"),
    database: str = Query(..., description="Database name"),
    table: str = Query(..., description="Table name"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=200, description="Rows per page"),
    username: str = Query(..., description="Business username from mysql_users"),
    current_user: dict = Depends(get_current_user),
):
    """Get paginated data from a table on a backend MySQL server."""
    if not _sanitize_identifier(database) or not _sanitize_identifier(table):
        raise HTTPException(status_code=400, detail="Invalid database or table name")

    password = await _get_user_password(server_id, username)

    try:
        rows, total, elapsed = await mysql_backend_client.get_table_data(
            hostname, port, username, password, database, table,
            page=page, page_size=page_size,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection to backend timed out")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to get table data: {e}")

    columns = list(rows[0].keys()) if rows else []

    return TableDataResponse(
        rows=rows,
        columns=columns,
        total=total,
        page=page,
        page_size=page_size,
        elapsed_ms=round(elapsed, 2),
    )


@router.post("/{server_id}/execute", response_model=ExecuteResponse)
async def execute_sql(
    server_id: str,
    request: ExecuteRequest,
    current_user: dict = Depends(get_current_user),
):
    """Execute a SQL statement directly on a backend MySQL server.

    Supports both SELECT (read) and INSERT/UPDATE/DELETE (write) statements.
    Results are limited to prevent accidental large data fetches.
    """
    sql = request.sql.strip()
    if not sql:
        raise HTTPException(status_code=400, detail="SQL statement is empty")

    # Basic SQL injection prevention — reject multiple statements
    if ";" in sql.rstrip(";"):
        raise HTTPException(
            status_code=400,
            detail="Multiple statements are not allowed. Please execute one statement at a time.",
        )

    # Determine statement type
    sql_upper = sql.upper().strip()
    is_select = sql_upper.startswith("SELECT") or sql_upper.startswith("SHOW") or sql_upper.startswith("DESCRIBE") or sql_upper.startswith("EXPLAIN")

    password = await _get_user_password(server_id, request.username)

    # Apply LIMIT to SELECT if not present
    if is_select and "LIMIT" not in sql_upper:
        sql = f"{sql.rstrip(';')} LIMIT {request.limit}"

    try:
        if is_select:
            rows, elapsed = await mysql_backend_client.execute_query(
                request.hostname, request.port, request.username, password, sql,
            )
            columns = list(rows[0].keys()) if rows else []
            return ExecuteResponse(
                type="select",
                rows=rows[:request.limit],
                columns=columns,
                row_count=len(rows),
                elapsed_ms=round(elapsed, 2),
            )
        else:
            affected, elapsed = await mysql_backend_client.execute_modify(
                request.hostname, request.port, request.username, password, sql,
            )
            return ExecuteResponse(
                type="modify",
                affected_rows=affected,
                row_count=affected,
                elapsed_ms=round(elapsed, 2),
            )
    except asyncio.TimeoutError:
        return ExecuteResponse(
            type="error",
            error="Query timed out",
            elapsed_ms=0,
        )
    except Exception as e:
        return ExecuteResponse(
            type="error",
            error=str(e),
            elapsed_ms=0,
        )


# ── Internal helpers ─────────────────────────────────────────────

async def _get_user_password(server_id: str, username: str) -> str:
    """Get a business user's password from ProxySQL's mysql_users table.

    ProxySQL stores mysql_users passwords in plaintext in its SQLite database.
    We query it directly via the admin interface.
    """
    creds = await get_proxysql_credentials(server_id)

    try:
        rows = await proxysql_service.execute_query(
            creds[0], creds[1], creds[2], creds[3],
            "SELECT password FROM mysql_users WHERE username = %s",
            (username,),
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to query mysql_users from ProxySQL: {e}",
        )

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"User '{username}' not found in mysql_users. "
                    "Make sure the user exists with backend=1 and active=1.",
        )

    return str(rows[0]["password"])
