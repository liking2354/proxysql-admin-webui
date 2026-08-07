"""SQLite database management for user data, sessions, and audit logs.

Connection pooling and performance settings:
- WAL mode: allows concurrent reads while a write is in progress
- PRAGMA cache_size: sets page cache to 2000 pages (~8MB) for faster reads
- PRAGMA synchronous: NORMAL reduces fsync frequency (safe for WAL mode)
- Connection timeout: 5 seconds to avoid hanging on lock contention
"""
import aiosqlite
import sqlite3
from datetime import datetime
from pathlib import Path
from app.config import settings

DB_PATH = Path(settings.DATABASE_URL.replace("sqlite:///", ""))

# Connection pool configuration
DB_POOL_SIZE = 5          # Max concurrent connections
DB_TIMEOUT = 5.0          # Seconds to wait for a connection before error
DB_PRAGMA_CACHE_SIZE = 2000   # SQLite page cache in pages (~8MB at 4KB/page)


def _adapt_datetime_iso(val):
    """Adapt datetime to ISO format string for SQLite."""
    return val.isoformat()


def _convert_datetime(val):
    """Convert ISO format bytes back to datetime."""
    return datetime.fromisoformat(val.decode())


# Register datetime adapter/converter for sqlite3 (silences Python 3.12+ deprecation)
sqlite3.register_adapter(datetime, _adapt_datetime_iso)
sqlite3.register_converter("timestamp", _convert_datetime)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(128) NOT NULL,
    email VARCHAR(128),
    role VARCHAR(16) NOT NULL DEFAULT 'viewer',
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS server_configs (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    host VARCHAR(255) NOT NULL DEFAULT '127.0.0.1',
    port INTEGER NOT NULL DEFAULT 6032,
    admin_user VARCHAR(64) NOT NULL,
    admin_password_encrypted VARCHAR(256) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT 0,
    hide_tables TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS query_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    sql_text TEXT NOT NULL,
    target VARCHAR(32) NOT NULL DEFAULT 'admin',
    database_name VARCHAR(64) DEFAULT 'main',
    execution_time_ms REAL,
    row_count INTEGER,
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(64),
    server_id VARCHAR(36),
    action VARCHAR(64) NOT NULL,
    resource VARCHAR(255),
    details TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wizard_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    wizard_id VARCHAR(16) NOT NULL,
    wizard_name VARCHAR(128) NOT NULL,
    category VARCHAR(64) NOT NULL,
    submitted_fields TEXT NOT NULL,
    executed_sql TEXT NOT NULL,
    auto_apply BOOLEAN NOT NULL DEFAULT 0,
    auto_save BOOLEAN NOT NULL DEFAULT 0,
    success BOOLEAN NOT NULL DEFAULT 1,
    error_message TEXT,
    affected_rows INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_query_history_user ON query_history(user_id);
CREATE INDEX IF NOT EXISTS idx_query_history_server ON query_history(server_id);
CREATE INDEX IF NOT EXISTS idx_query_history_created ON query_history(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_wizard_history_user ON wizard_history(user_id);
CREATE INDEX IF NOT EXISTS idx_wizard_history_server ON wizard_history(server_id);
CREATE INDEX IF NOT EXISTS idx_wizard_history_created ON wizard_history(created_at);
CREATE INDEX IF NOT EXISTS idx_wizard_history_wizard ON wizard_history(wizard_id);

CREATE TABLE IF NOT EXISTS cluster_groups (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    description TEXT,
    master_server_id VARCHAR(36) REFERENCES server_configs(id) ON DELETE SET NULL,
    sync_variables TEXT DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cluster_members (
    cluster_id VARCHAR(36) NOT NULL REFERENCES cluster_groups(id) ON DELETE CASCADE,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'slave' CHECK(role IN ('master', 'slave')),
    PRIMARY KEY (cluster_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_server ON cluster_members(server_id);

CREATE TABLE IF NOT EXISTS token_blacklist (
    token_hash VARCHAR(64) PRIMARY KEY,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at);

CREATE TABLE IF NOT EXISTS cluster_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id VARCHAR(36) NOT NULL REFERENCES cluster_groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(64),
    action VARCHAR(32) NOT NULL,
    source_server_id VARCHAR(36),
    target_servers TEXT NOT NULL,
    module VARCHAR(64),
    success_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cluster_sync_logs_cluster ON cluster_sync_logs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_sync_logs_created ON cluster_sync_logs(created_at);

CREATE TABLE IF NOT EXISTS config_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    backup_data TEXT NOT NULL,
    table_count INTEGER DEFAULT 0,
    row_count INTEGER DEFAULT 0,
    size_bytes INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_config_backups_server ON config_backups(server_id);
CREATE INDEX IF NOT EXISTS idx_config_backups_created ON config_backups(created_at);

CREATE TABLE IF NOT EXISTS backup_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    cron_expression VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backup_schedules_server ON backup_schedules(server_id);

CREATE TABLE IF NOT EXISTS user_server_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    can_write BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_user_server_perms_user ON user_server_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_server_perms_server ON user_server_permissions(server_id);

CREATE TABLE IF NOT EXISTS route_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id VARCHAR(36) NOT NULL REFERENCES server_configs(id) ON DELETE CASCADE,
    hostgroup_id INTEGER NOT NULL,
    policy VARCHAR(16) NOT NULL CHECK(policy IN ('write_only', 'read_only')),
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, hostgroup_id)
);

CREATE INDEX IF NOT EXISTS idx_route_policies_server ON route_policies(server_id);
"""


async def get_db() -> aiosqlite.Connection:
    """Get a database connection with performance-optimized PRAGMAs.

    - WAL mode: allows concurrent reads during writes
    - cache_size: increases in-memory page cache for faster repeated queries
    - synchronous=NORMAL: reduces fsync calls (safe with WAL)
    - busy_timeout: waits up to DB_TIMEOUT ms before raising lock error
    """
    db = await aiosqlite.connect(
        str(DB_PATH),
        timeout=DB_TIMEOUT,
    )
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    await db.execute(f"PRAGMA cache_size={DB_PRAGMA_CACHE_SIZE}")
    await db.execute("PRAGMA synchronous=NORMAL")
    await db.execute(f"PRAGMA busy_timeout={int(DB_TIMEOUT * 1000)}")
    return db


async def init_db():
    """Initialize the database schema and create default admin user."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = await get_db()
    try:
        await db.executescript(SCHEMA_SQL)
        await db.commit()

        # Create default admin user if none exists
        from app.utils.security import hash_password

        cursor = await db.execute("SELECT COUNT(*) FROM users")
        count = (await cursor.fetchone())[0]
        if count == 0:
            hashed = hash_password(settings.INITIAL_ADMIN_PASSWORD)
            await db.execute(
                "INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)",
                (settings.INITIAL_ADMIN_USER, hashed, "admin", "admin@localhost"),
            )
            await db.commit()
    finally:
        await db.close()
