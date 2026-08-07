"""Response models for per-server route policy & misroute detection endpoints.

A "route policy" declares the intended role of a ProxySQL hostgroup for a
given server instance (e.g. HG10=write_only, HG20=read_only). Different
ProxySQL instances managed by this WebUI may define entirely different
policies, or none at all — policies are always scoped to a single server_id.
"""

from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


class RoutePolicyItem(BaseModel):
    """A single hostgroup role declaration for one server."""
    id: int = Field(description="Unique policy ID.")
    server_id: str = Field(description="ProxySQL server identifier.")
    hostgroup_id: int = Field(description="Target hostgroup ID.", examples=[10])
    policy: Literal["write_only", "read_only"] = Field(
        description="Intended role of this hostgroup: write_only (should only "
                    "receive DML/DDL/locking reads) or read_only (should only "
                    "receive plain SELECTs).",
    )
    enabled: bool = Field(default=True, description="Whether this policy is actively checked.")
    created_at: datetime
    updated_at: Optional[datetime] = None


class RoutePolicyListResponse(BaseModel):
    """All policies defined for a server."""
    policies: list[RoutePolicyItem] = Field(
        description="Hostgroup role declarations for this server, ordered by hostgroup_id."
    )


class MisrouteViolation(BaseModel):
    """A single query digest that violates its hostgroup's declared policy."""
    hostgroup_id: int = Field(description="Hostgroup where the violation was observed.")
    policy: Literal["write_only", "read_only"] = Field(description="The policy that was violated.")
    severity: Literal["critical", "warning"] = Field(
        description="critical: data-safety risk (e.g. write landed on a read_only "
                    "hostgroup). warning: inefficient but not unsafe (e.g. plain "
                    "read landed on a write_only hostgroup).",
    )
    digest_text: str = Field(description="Normalized SQL text (ProxySQL digest_text).")
    count_star: int = Field(description="Number of times this digest has executed since last reset.")
    first_seen: Optional[datetime] = Field(default=None, description="First time this digest was seen.")
    last_seen: Optional[datetime] = Field(default=None, description="Most recent execution time.")


class MisrouteCheckResponse(BaseModel):
    """Result of an on-demand misroute check against live ProxySQL stats."""
    checked_at: datetime = Field(description="UTC timestamp when the check ran.")
    policies_defined: bool = Field(
        description="False if this server has no enabled route policies — in that "
                    "case violations is always empty and no check is meaningful.",
    )
    violations: list[MisrouteViolation] = Field(default_factory=list)
    has_critical: bool = Field(
        default=False,
        description="True if any violation has severity=critical.",
    )
