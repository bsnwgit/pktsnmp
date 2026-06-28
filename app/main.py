"""
pktSNMP — FastAPI application entry point.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db
from app.storage.factory import init_storage, get_storage

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api import (
    snmp as snmp_router,
    settings as settings_router,
    auth,
    users,
    system as system_router,
)
from app.api import logs as logs_router

settings = get_settings()
log = logging.getLogger("pktsnmp")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # ── Startup ───────────────────────────────────────────────────────────────
    # Attach SQLite log handler before anything else so startup events are captured.
    from app.logging_handler import SQLiteLogHandler
    _log_handler = SQLiteLogHandler(db_path=settings.db_path)
    _log_handler.attach_to_root_logger("pktsnmp")

    log.info("pktSNMP starting up")

    # Run SQLite migrations
    await init_db()
    log.info("Database migrations applied")

    # Connect to storage backend
    await init_storage()
    log.info(f"Storage ready: {get_storage().__class__.__name__}")

    # Start alert engine
    from app.alerts.engine import AlertEngine
    engine = AlertEngine()
    await engine.start(settings.db_path)
    app.state.alert_engine = engine
    log.info("Alert engine started")

    # Start alert event cleanup job
    from app.alerts.cleanup import AlertCleanup
    cleanup = AlertCleanup()
    await cleanup.start()
    log.info("Alert cleanup started")

    # Start backup scheduler
    from app.backup import BackupScheduler
    backup_scheduler = BackupScheduler()
    await backup_scheduler.start()
    log.info("Backup scheduler started")

    # Seed OID catalog
    from app.snmp.oid_catalog import seed_catalog
    import aiosqlite as _aiosqlite
    async with _aiosqlite.connect(settings.db_path) as _oid_db:
        await seed_catalog(_oid_db)
    log.info("OID catalog seeded")

    # Start local SNMP collector (wire in alert engine)
    from app.snmp.local_collector import LocalCollector
    local_collector = LocalCollector(alert_engine=engine)
    await local_collector.start(settings.db_path)
    app.state.local_collector = local_collector
    log.info("Local SNMP collector started")

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    log.info("pktSNMP shutting down")
    if hasattr(app.state, "local_collector"):
        await app.state.local_collector.stop()
    await engine.stop()
    await cleanup.stop()
    await backup_scheduler.stop()
    from app.storage.factory import close_storage
    await close_storage()
    _log_handler.stop()
    log.info("Shutdown complete")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="pktSNMP",
    description="Enterprise SNMP Ingest Management & Visualization Platform",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API Routers ───────────────────────────────────────────────────────────────

from app.api import alerts as alerts_router

app.include_router(auth.router,            prefix="/api/auth",     tags=["auth"])
app.include_router(users.router,           prefix="/api/users",    tags=["users"])
app.include_router(snmp_router.router,     prefix="/api/snmp",     tags=["snmp"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
app.include_router(system_router.router,   prefix="/api/system",   tags=["system"])
app.include_router(alerts_router.router,   prefix="/api/alerts",   tags=["alerts"])
app.include_router(logs_router.router,     prefix="/api/logs",     tags=["logs"])

# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok", "version": "0.1.0"}

# ── Serve React frontend (production build) ───────────────────────────────────
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        static_file = _frontend_dist / full_path
        if static_file.exists() and static_file.is_file():
            return FileResponse(str(static_file))
        index = _frontend_dist / "index.html"
        return FileResponse(str(index))


# ── Entrypoint (used by systemd: python -m app.main) ─────────────────────────
if __name__ == "__main__":
    import json
    import sqlite3
    import uvicorn

    # Read SSL settings from SQLite before uvicorn starts
    _db_path = Path(__file__).parent.parent / "pktsnmp.db"
    _ssl_enabled  = False
    _ssl_certfile = None
    _ssl_keyfile  = None
    try:
        _conn = sqlite3.connect(str(_db_path))
        for _key in ("ssl_enabled", "ssl_certfile", "ssl_keyfile"):
            _row = _conn.execute("SELECT value FROM settings WHERE key=?", (_key,)).fetchone()
            if _row:
                _val = json.loads(_row[0])
                if _key == "ssl_enabled":
                    _ssl_enabled = bool(_val)
                elif _key == "ssl_certfile":
                    _ssl_certfile = _val if _val else None
                elif _key == "ssl_keyfile":
                    _ssl_keyfile = _val if _val else None
        _conn.close()
    except Exception as _e:
        log.warning(f"Could not read SSL settings from config DB: {_e}")

    _uvicorn_kwargs = dict(
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        workers=1,
    )
    if _ssl_enabled and _ssl_certfile and _ssl_keyfile:
        _uvicorn_kwargs["ssl_certfile"] = _ssl_certfile
        _uvicorn_kwargs["ssl_keyfile"]  = _ssl_keyfile
        log.info(f"Starting with HTTPS: cert={_ssl_certfile}")
    else:
        log.info("Starting with HTTP (no SSL configured)")

    uvicorn.run("app.main:app", **_uvicorn_kwargs)
