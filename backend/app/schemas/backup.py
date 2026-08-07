"""Response models for backup & restore API endpoints."""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class BackupItem(BaseModel):
    """A single backup entry."""
    id: int = Field(description="Unique backup ID.")
    server_id: str = Field(description="ProxySQL server identifier.")
    name: Optional[str] = Field(default=None, description="User-provided backup name.")
    description: Optional[str] = Field(default=None, description="Optional description.")
    created_by: str = Field(description="Username who created the backup.")
    created_at: datetime = Field(description="ISO 8601 creation timestamp.")
    size_bytes: Optional[int] = Field(default=None, description="Backup data size in bytes.")
    table_count: int = Field(default=0, description="Number of config tables included in the backup.")
    row_count: int = Field(default=0, description="Total number of rows across all tables in the backup.")


class BackupListResponse(BaseModel):
    """List of backups for a server."""
    backups: list[BackupItem] = Field(
        description="All backups for the specified server, newest first.",
    )


class BackupCreateResponse(BaseModel):
    """Response after creating a backup."""
    id: int = Field(description="Newly created backup ID.")
    server_id: str = Field(description="Server the backup was taken from.")
    name: Optional[str] = Field(default=None)
    created_at: datetime = Field(description="ISO 8601 creation timestamp.")
    message: str = Field(default="Backup created successfully")


class BackupRestoreResponse(BaseModel):
    """Response after restoring a backup."""
    message: str = Field(description="Restore result message.")
    tables_restored: int = Field(
        default=0,
        description="Number of config tables restored.",
    )
    tables_skipped: int = Field(
        default=0,
        description="Number of tables skipped (e.g. filtered out).",
    )


class BatchDeleteResponse(BaseModel):
    """Response after batch-deleting backups."""
    ok: bool = Field(default=True)
    deleted_count: int = Field(
        description="Number of backups successfully deleted.",
        examples=[5],
    )


class BatchCreateResult(BaseModel):
    """Result for a single server in a batch create operation."""
    server_id: str
    success: bool
    backup_id: Optional[int] = Field(default=None, description="Created backup ID (if successful).")
    error: Optional[str] = Field(default=None, description="Error message (if failed).")


class BatchCreateResponse(BaseModel):
    """Response after batch-creating backups across multiple servers."""
    ok: bool = Field(default=True)
    total: int = Field(description="Total number of servers in the request.")
    succeeded: int = Field(description="Number of successful backups.")
    failed: int = Field(description="Number of failed backups.")
    results: list[BatchCreateResult] = Field(description="Per-server results.")
