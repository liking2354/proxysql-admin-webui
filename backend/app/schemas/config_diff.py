"""Response models for config diff API."""

from typing import Any, Optional
from pydantic import BaseModel, Field


class TableDiff(BaseModel):
    """Diff result for a single config table."""
    table: str = Field(description="Config table name.")
    in_sync: bool = Field(description="True if Memory and Runtime layers match.")
    applicable: bool = Field(
        default=True,
        description=(
            "False for static tables that have no runtime counterpart "
            "(e.g. mysql_collations) and therefore can never be applied."
        ),
    )
    memory_rows: int = Field(description="Number of rows in Memory layer.")
    runtime_rows: int = Field(description="Number of rows in Runtime layer.")
    only_in_memory: int = Field(
        default=0,
        description="Rows present only in Memory (pending apply).",
    )
    only_in_runtime: int = Field(
        default=0,
        description="Rows present only in Runtime (pending discard).",
    )
    diff: Optional[dict[str, Any]] = Field(
        default=None,
        description="Detailed diff data (added/removed/unchanged). None if in_sync.",
    )


class ConfigDiffResponse(BaseModel):
    """Full configuration diff across all synced tables."""
    server_id: str = Field(description="ProxySQL server identifier.")
    tables: list[TableDiff] = Field(description="Per-table diff results.")
    total_tables: int = Field(description="Total number of tables diffed.")
    total_out_of_sync: int = Field(
        description="Number of tables with unsynchronized changes.",
    )
