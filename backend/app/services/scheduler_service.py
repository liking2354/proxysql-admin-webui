"""Application-level task scheduler using APScheduler.

Provides:
- Periodic auto-backup for configured ProxySQL servers
- CRON-based schedule management
- Persistent schedule storage in SQLite
- Periodic misroute watch: scans all servers that have route policies
  defined and logs an audit entry if a policy-violating SQL digest is found
"""

from datetime import datetime
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.database import get_db

# How often to scan for policy-violating SQL across all servers that have
# route policies configured. Kept short (minutes, not hours) since the goal
# is to catch a misroute close to when it happens, not in a nightly batch.
MISROUTE_WATCH_INTERVAL_MINUTES = 5


class SchedulerService:
    """Manages scheduled tasks (auto-backup, health checks, etc.)."""

    def __init__(self):
        self._scheduler = AsyncIOScheduler()
        self._job_prefix = "proxysql_"
        self._started = False

    async def start(self) -> None:
        """Load saved schedules from DB and start the scheduler."""
        if self._started:
            return

        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT id, server_id, cron_expression FROM backup_schedules WHERE enabled = 1"
            )
            rows = await cursor.fetchall()
        finally:
            await db.close()

        for row in rows:
            self._add_job(row["id"], row["server_id"], row["cron_expression"])

        # Periodic misroute watch: single recurring job, not per-server —
        # it internally iterates whichever servers currently have policies.
        self._scheduler.add_job(
            self._run_misroute_watch,
            IntervalTrigger(minutes=MISROUTE_WATCH_INTERVAL_MINUTES),
            id=f"{self._job_prefix}misroute_watch",
            replace_existing=True,
        )

        self._scheduler.start()
        self._started = True

    async def shutdown(self) -> None:
        """Gracefully shut down the scheduler."""
        if self._started:
            self._scheduler.shutdown(wait=False)
            self._started = False

    async def add_backup_schedule(
        self, server_id: str, cron_expression: str
    ) -> dict:
        """Create a new auto-backup schedule.

        Args:
            server_id: The ProxySQL server UUID.
            cron_expression: CRON string, e.g. "0 3 * * *" (daily at 3am).

        Returns:
            dict with schedule metadata (id, server_id, cron_expression).
        """
        db = await get_db()
        try:
            cursor = await db.execute(
                """INSERT INTO backup_schedules (server_id, cron_expression)
                   VALUES (?, ?)""",
                (server_id, cron_expression),
            )
            await db.commit()
            schedule_id = cursor.lastrowid
            self._add_job(schedule_id, server_id, cron_expression)
        finally:
            await db.close()

        return {
            "id": schedule_id,
            "server_id": server_id,
            "cron_expression": cron_expression,
        }

    async def list_schedules(self) -> list[dict]:
        """List all backup schedules."""
        db = await get_db()
        try:
            cursor = await db.execute(
                """SELECT id, server_id, cron_expression, enabled, created_at
                   FROM backup_schedules ORDER BY created_at DESC"""
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
        finally:
            await db.close()

    async def remove_schedule(self, schedule_id: int) -> bool:
        """Remove a backup schedule by ID."""
        db = await get_db()
        try:
            cursor = await db.execute(
                "DELETE FROM backup_schedules WHERE id = ?", (schedule_id,)
            )
            await db.commit()
            deleted = cursor.rowcount > 0
        finally:
            await db.close()

        if deleted:
            job_id = f"{self._job_prefix}backup_{schedule_id}"
            if self._scheduler.get_job(job_id):
                self._scheduler.remove_job(job_id)

        return deleted

    def _add_job(self, schedule_id: int, server_id: str, cron_expression: str) -> None:
        """Add a job to the APScheduler instance."""
        job_id = f"{self._job_prefix}backup_{schedule_id}"
        self._scheduler.add_job(
            self._run_backup,
            CronTrigger.from_crontab(cron_expression),
            id=job_id,
            args=[server_id],
            replace_existing=True,
        )

    async def _run_backup(self, server_id: str) -> None:
        """Execute an auto-backup for the given server."""
        import logging
        logger = logging.getLogger(__name__)
        try:
            from app.services.backup_service import backup_service
            from app.utils.db_helpers import get_proxysql_credentials
            host, port, admin_user, password = await get_proxysql_credentials(server_id)
            result = await backup_service.create_backup(
                server_id=server_id,
                user_id=0,  # system
                host=host,
                port=port,
                user=admin_user,
                password=password,
                name=f"Auto-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}",
            )
            logger.info("auto-backup created", extra={"server_id": server_id, "backup_id": result["id"]})
        except Exception as e:
            logger.error("auto-backup failed", extra={"server_id": server_id, "error": str(e)})

    async def _run_misroute_watch(self) -> None:
        """Scan every server that has route policies for policy violations.

        Only servers with at least one enabled route_policies row are
        checked — this keeps the job a no-op for instances that never
        declared a routing strategy (per-server, not global, by design).
        On a critical violation, logs ONE summarizing audit_logs entry per
        server per run (not one per digest) to avoid log spam; since
        ProxySQL's digest counters are cumulative, the same violation will
        keep re-alerting on every run until the digest stats are reset via
        the "重置统计" action — this is intentional (keeps nagging until
        acknowledged), not a bug.
        """
        import logging
        logger = logging.getLogger(__name__)
        try:
            db = await get_db()
            try:
                cursor = await db.execute(
                    "SELECT DISTINCT server_id FROM route_policies WHERE enabled = 1"
                )
                server_ids = [r["server_id"] for r in await cursor.fetchall()]
            finally:
                await db.close()

            if not server_ids:
                return

            from app.services.route_policy_service import route_policy_service
            from app.utils.db_helpers import get_proxysql_credentials
            from app.middleware.audit import audit_log

            for server_id in server_ids:
                try:
                    host, port, admin_user, password = await get_proxysql_credentials(server_id)
                    result = await route_policy_service.check_misroute(
                        server_id, host, port, admin_user, password
                    )
                    if result["has_critical"]:
                        critical = [v for v in result["violations"] if v["severity"] == "critical"]
                        top = critical[0]
                        await audit_log(
                            user_id=None,
                            username="system",
                            action="misroute_detected",
                            resource="route_policy",
                            server_id=server_id,
                            details={
                                "critical_count": len(critical),
                                "top_hostgroup": top["hostgroup_id"],
                                "top_digest_text": top["digest_text"][:200],
                                "top_count_star": top["count_star"],
                            },
                        )
                        logger.warning(
                            "misroute detected",
                            extra={"server_id": server_id, "critical_count": len(critical)},
                        )
                except Exception as e:
                    logger.error(
                        "misroute watch failed for server",
                        extra={"server_id": server_id, "error": str(e)},
                    )
        except Exception as e:
            logger.error("misroute watch job failed", extra={"error": str(e)})


scheduler_service = SchedulerService()
