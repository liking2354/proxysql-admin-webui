"""Main FastAPI application entry point.

A simple, single-process deployment: the FastAPI app serves both the
REST/WebSocket API *and* the built frontend (frontend/dist) as static files
on the same origin. The whole UI runs from one `uvicorn` process.

This is an internal tool for managing ProxySQL — it does NOT need the
layers of security hardening that a public-facing SaaS product requires.
"""
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import init_db
from app.version import get_version
from app.api.v1 import (
    auth, tables, sync, query, dashboard, users, servers, wizards,
    config_diff, clusters, templates, backup, export, scheduler,
    db_manager, route_policies,
)
from app.api.v1 import settings as settings_api
from app.schemas.response import HealthResponse


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: init DB, start scheduler, setup structured logging."""
    from app.utils.logger import setup_logging
    setup_logging(
        log_level=settings.LOG_LEVEL,
        json_format=os.getenv("LOG_FORMAT", "").lower() != "text",
    )
    await init_db()
    # Initialize cache TTLs (hard-coded defaults for simple deployment)
    from app.services.cache_service import cache_service
    cache_service._dashboard_ttl = 10
    cache_service._config_diff_ttl = 60
    # Start the APScheduler for auto-backup tasks
    from app.services.scheduler_service import scheduler_service
    await scheduler_service.start()
    yield
    await scheduler_service.shutdown()


app = FastAPI(
    title="ProxySQL Admin WebUI",
    description="Web-based management interface for ProxySQL",
    version=get_version(),
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# Only middleware we need: GZip for response compression.
# This is a simple internal tool — no CORS, CSRF, rate limiting, security
# headers, audit logging, metrics, body limits, or cache headers.
app.add_middleware(GZipMiddleware, minimum_size=500)

# ── API routes ─────────────────────────────────────────────────────
app.include_router(auth.router, prefix="/api/v1/auth", tags=["Auth"])
app.include_router(tables.router, prefix="/api/v1", tags=["Tables"])
app.include_router(sync.router, prefix="/api/v1/sync", tags=["Config Sync"])
app.include_router(query.router, prefix="/api/v1/query", tags=["Query"])
app.include_router(dashboard.router, prefix="/api/v1/dashboard", tags=["Dashboard"])
app.include_router(users.router, prefix="/api/v1/users", tags=["Users"])
app.include_router(servers.router, prefix="/api/v1/servers", tags=["Servers"])
app.include_router(wizards.router, prefix="/api/v1/wizards", tags=["Wizards"])
app.include_router(templates.router, prefix="/api/v1/wizards", tags=["Templates"])
app.include_router(settings_api.router, prefix="/api/v1/settings", tags=["Settings"])
app.include_router(config_diff.router, prefix="/api/v1/config-diff", tags=["Config Diff"])
app.include_router(clusters.router, prefix="/api/v1/clusters", tags=["Clusters"])
app.include_router(backup.router, prefix="/api/v1/backup", tags=["Backup"])
app.include_router(export.router, prefix="/api/v1/export", tags=["Export"])
app.include_router(scheduler.router, prefix="/api/v1/scheduler", tags=["Scheduler"])
app.include_router(route_policies.router, prefix="/api/v1/route-policies", tags=["Route Policies"])
app.include_router(db_manager.router, tags=["Database Manager"])
app.include_router(dashboard.ws_router, prefix="/ws/dashboard", tags=["Dashboard WS"])


@app.get("/api/v1/health", response_model=HealthResponse, tags=["System"])
async def health_check():
    """Deep health check: verifies API availability and database connectivity.

    Returns:
        JSON with ``status``, ``version``, and ``database`` fields.
    """
    db_ok = False
    try:
        from app.database import get_db
        db = await get_db()
        try:
            await db.execute("SELECT 1")
            db_ok = True
        finally:
            await db.close()
    except Exception:
        db_ok = False

    return {
        "status": "ok" if db_ok else "degraded",
        "version": get_version(),
        "database": "ok" if db_ok else "error",
    }


# Debug endpoint to check if frontend assets are configured correctly
@app.get("/api/v1/debug/assets-info", tags=["Debug"])
async def assets_info():
    """Debug endpoint to check frontend assets configuration."""
    # Check if assets dir was mounted
    _assets_dir_path = None
    _assets_mounted = False
    if not _DEV_MODE and _FRONTEND_DIST.is_dir():
        _assets_dir_path = _FRONTEND_DIST / "assets"
        _assets_mounted = _assets_dir_path.exists()
    
    return {
        "frontend_dist": str(_FRONTEND_DIST),
        "frontend_dist_exists": _FRONTEND_DIST.exists(),
        "frontend_dist_is_dir": _FRONTEND_DIST.is_dir() if _FRONTEND_DIST.exists() else False,
        "assets_dir": str(_assets_dir_path) if _assets_dir_path else "not configured",
        "assets_mounted": _assets_mounted,
        "dev_mode": _DEV_MODE,
    }


# ── Serve the built frontend (SPA) from the same origin ──────────────
# Resolve the frontend dist directory. It can be overridden via the
# FRONTEND_DIST env var (used by the Docker image) and defaults to
# ../frontend/dist relative to this file (bare-metal `make run`).
#
# When DEV_MODE=true (set by `make dev-backend`), we skip serving the
# frontend so that the Vite dev server on :5173 handles it with hot-reload.
_DEV_MODE = os.getenv("DEV_MODE", "").lower() in ("1", "true", "yes")
_DIST_ENV = os.getenv("FRONTEND_DIST")

if getattr(sys, "frozen", False):
    # Running as a PyInstaller single-file bundle: frontend/dist is
    # embedded via --add-data and unpacked into sys._MEIPASS at runtime.
    _FRONTEND_DIST = Path(sys._MEIPASS) / "frontend" / "dist"
elif _DIST_ENV:
    _FRONTEND_DIST = Path(_DIST_ENV).resolve()
else:
    _FRONTEND_DIST = (
        Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    )

if not _DEV_MODE and _FRONTEND_DIST.is_dir():
    # Mount static assets (js/css/images) at /assets.
    _ASSETS_DIR = _FRONTEND_DIST / "assets"
    if _ASSETS_DIR.is_dir():
        # Use StaticFiles with check_dir=False for better compatibility
        app.mount("/assets", StaticFiles(directory=str(_ASSETS_DIR), check_dir=False), name="assets")
        print(f"[StaticFiles] Mounted /assets at {_ASSETS_DIR}")
    else:
        print(f"[StaticFiles] WARNING: assets directory not found at {_ASSETS_DIR}")

    _INDEX_HTML = _FRONTEND_DIST / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """Catch-all that serves index.html for any non-API path.

        This implements client-side routing: visiting /dashboard,
        /wizards/W01, etc. returns the SPA shell which then renders the
        matching route. Real files under /assets are handled by the
        StaticFiles mount above and never reach this handler.
        """
        # Never shadow API / WebSocket / docs routes.
        if full_path.startswith(("api/", "ws/")):
            return {"detail": "Not Found"}
        candidate = _FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_INDEX_HTML))
else:
    # No built frontend present, or DEV_MODE=true.
    # Surface a helpful message instead of 404'ing every request.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def _no_frontend(full_path: str):
        if full_path.startswith(("api/", "ws/")):
            return {"detail": "Not Found"}
        if _DEV_MODE:
            return {
                "detail": (
                    "Backend-only dev mode. Frontend is served by Vite on "
                    "http://localhost:5173 (run `make dev-frontend` in another terminal)."
                )
            }
        return {
            "detail": (
                "Frontend build not found. Run `make build-frontend` "
                f"(expected at {_FRONTEND_DIST})."
            )
        }
