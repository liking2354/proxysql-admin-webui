"""Per-server routing policy definitions and misroute detection.

A "policy" declares the intended role of a ProxySQL hostgroup for a given
server instance (e.g. HG10=write_only/A库, HG20=read_only/B库). Different
ProxySQL instances managed by this WebUI may have entirely different
policies — or none at all. Policies are always scoped to a single
server_id, never global, so a "写走A读走B" strategy on one instance never
affects how another instance is checked.

Detection works by reading ProxySQL's own `stats_mysql_query_digest`
(no extra logging infrastructure needed) and classifying each digest's
SQL verb against the declared policy for the hostgroup it actually ran on.
"""
import re
from datetime import datetime, timezone
from typing import Optional

from app.database import get_db
from app.services.proxysql import proxysql_service

# ProxySQL's digest_text RETAINS SQL comments (verified empirically — MyBatis
# mapper comments / APM trace-id comments are NOT stripped). The write-verb
# regex therefore explicitly skips over any number of leading comments
# (/* */, --, #) before matching the actual statement keyword.
_LEADING_COMMENTS = r"(?:(?:/\*[\s\S]*?\*/|--[^\n]*|#[^\n]*)\s*)*"
WRITE_VERB_RE = re.compile(
    rf"(?i)^\s*{_LEADING_COMMENTS}"
    r"(insert|replace|update|delete|truncate|create|alter|drop|rename|lock)\b"
)
LOCKING_READ_RE = re.compile(r"(?i)\b(for\s+update|lock\s+in\s+share\s+mode)\b")


class RoutePolicyService:
    """CRUD for route policies + live misroute detection against ProxySQL stats."""

    async def list_policies(self, server_id: str) -> list[dict]:
        """List all policies (enabled or not) for a server, ordered by hostgroup."""
        db = await get_db()
        try:
            cursor = await db.execute(
                """SELECT id, server_id, hostgroup_id, policy, enabled, created_at, updated_at
                   FROM route_policies WHERE server_id = ? ORDER BY hostgroup_id""",
                (server_id,),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
        finally:
            await db.close()

    async def upsert_policy(
        self, server_id: str, hostgroup_id: int, policy: str, enabled: bool = True
    ) -> dict:
        """Create or update the policy for a (server_id, hostgroup_id) pair."""
        db = await get_db()
        try:
            await db.execute(
                """INSERT INTO route_policies (server_id, hostgroup_id, policy, enabled)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(server_id, hostgroup_id)
                   DO UPDATE SET policy = excluded.policy,
                                 enabled = excluded.enabled,
                                 updated_at = CURRENT_TIMESTAMP""",
                (server_id, hostgroup_id, policy, int(enabled)),
            )
            await db.commit()
            cursor = await db.execute(
                """SELECT id, server_id, hostgroup_id, policy, enabled, created_at, updated_at
                   FROM route_policies WHERE server_id = ? AND hostgroup_id = ?""",
                (server_id, hostgroup_id),
            )
            row = await cursor.fetchone()
            return dict(row)
        finally:
            await db.close()

    async def delete_policy(self, server_id: str, policy_id: int) -> bool:
        """Delete a policy by ID, scoped to server_id to avoid cross-server deletes."""
        db = await get_db()
        try:
            cursor = await db.execute(
                "DELETE FROM route_policies WHERE id = ? AND server_id = ?",
                (policy_id, server_id),
            )
            await db.commit()
            return cursor.rowcount > 0
        finally:
            await db.close()

    async def check_misroute(
        self, server_id: str, host: str, port: int, user: str, password: str
    ) -> dict:
        """Run a live misroute check against ProxySQL's query digest stats.

        For each hostgroup with an enabled policy, scans stats_mysql_query_digest
        for digests that violate the declared role:
          - read_only hostgroup + write verb or locking read  -> critical
          - write_only hostgroup + plain (non-locking) read   -> warning (wasteful,
            not unsafe — e.g. an unnecessary cross-cloud read)
        """
        policies = await self.list_policies(server_id)
        active_policies = {p["hostgroup_id"]: p["policy"] for p in policies if p["enabled"]}
        checked_at = datetime.now(timezone.utc)

        if not active_policies:
            return {
                "checked_at": checked_at,
                "policies_defined": False,
                "violations": [],
                "has_critical": False,
            }

        rows = await proxysql_service.execute_query(
            host, port, user, password,
            "SELECT hostgroup, digest_text, count_star, first_seen, last_seen "
            "FROM stats_mysql_query_digest",
        )

        violations = []
        for r in rows:
            try:
                hg = int(r.get("hostgroup"))
            except (TypeError, ValueError):
                continue
            if hg not in active_policies:
                continue

            policy = active_policies[hg]
            digest_text = r.get("digest_text") or ""
            is_write = bool(WRITE_VERB_RE.search(digest_text))
            is_locking_read = (not is_write) and bool(LOCKING_READ_RE.search(digest_text))

            severity: Optional[str] = None
            if policy == "read_only" and (is_write or is_locking_read):
                severity = "critical"
            elif policy == "write_only" and not is_write and not is_locking_read:
                severity = "warning"

            if severity:
                violations.append({
                    "hostgroup_id": hg,
                    "policy": policy,
                    "severity": severity,
                    "digest_text": digest_text,
                    "count_star": int(r.get("count_star") or 0),
                    "first_seen": r.get("first_seen"),
                    "last_seen": r.get("last_seen"),
                })

        violations.sort(key=lambda v: (v["severity"] != "critical", -v["count_star"]))
        has_critical = any(v["severity"] == "critical" for v in violations)

        return {
            "checked_at": checked_at,
            "policies_defined": True,
            "violations": violations,
            "has_critical": has_critical,
        }

    async def reset_digest_stats(self, host: str, port: int, user: str, password: str) -> None:
        """Clear ProxySQL's query digest counters.

        ProxySQL resets stats_mysql_query_digest as a side effect of reading
        from the special stats_mysql_query_digest_reset table. Use this after
        investigating/fixing a violation so old counts stop re-triggering alerts.
        """
        await proxysql_service.execute_query(
            host, port, user, password,
            "SELECT 1 FROM stats_mysql_query_digest_reset LIMIT 1",
        )


route_policy_service = RoutePolicyService()
