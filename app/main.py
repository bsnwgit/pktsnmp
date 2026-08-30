"""
pktSNMP — FastAPI application entry point.
"""
from __future__ import annotations

import logging
import os.path
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db, seed_admin
from app.storage.factory import init_storage, get_storage

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api import (
    snmp as snmp_router,
    settings as settings_router,
    auth,
    users,
    system as system_router,
)
from app.api import suite as suite_router
from app.api import logs as logs_router
from app.api import user_api_keys as user_api_keys_router
from app.api import ip_info as ip_info_router
from app.api import mxtoolbox as mxtoolbox_router
from app.api import integrations as integrations_router
from app.api import widgets as widgets_router
from app.api import nav as nav_router
from app.api import docs as docs_router

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

    # Ship our own logs to pktLog if configured.
    try:
        import json as _json, logging as _logging
        import aiosqlite as _aio
        _fwd: dict = {}
        async with _aio.connect(settings.db_path) as _db:
            async with _db.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'log_forward_%'"
            ) as _cur:
                for _k, _v in await _cur.fetchall():
                    try:
                        _fwd[_k] = _json.loads(_v)
                    except Exception:
                        _fwd[_k] = _v
        if _fwd.get("log_forward_enabled"):
            from app.log_forward import configure_forwarding
            configure_forwarding(
                enabled=True,
                host=str(_fwd.get("log_forward_host") or ""),
                port=int(_fwd.get("log_forward_port") or 5514),
                protocol=str(_fwd.get("log_forward_protocol") or "udp"),
                level=getattr(_logging, str(_fwd.get("log_forward_level") or "INFO"), _logging.INFO),
                app_name=str(_fwd.get("log_forward_app_name") or "pktsnmp"),
            )
    except Exception as _e:
        log.warning(f"Log forwarding setup skipped: {_e}")

    # Run SQLite migrations
    await init_db()
    log.info("Database migrations applied")

    # Seed initial admin user (first boot only; no-op if users already exist)
    await seed_admin()
    log.info("Admin seed check complete")

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

    # Start time-series retention. The backends have always implemented
    # run_cleanup() and Settings has always exposed retention_days_raw, but
    # nothing called it — poll results accumulated forever regardless of the
    # configured retention. This is what makes that setting real.
    from app.storage.retention import StorageRetention
    retention = StorageRetention()
    await retention.start()
    log.info("Storage retention started")

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
    await retention.stop()
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


def _decode_setting(raw):
    """
    Read one settings-table value. They are JSON-encoded, but rows written
    before that convention settled are bare strings — decode tolerantly, the
    same way app/config.py reads suite_token.
    """
    import json
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


# Paths that answer even while pktHub has this app locked. /api/suite/ is the
# one that must never be removed: it is the channel pktHub unlocks through, and
# without it a lock could only be lifted by editing the database by hand.
# /api/auth/ carries the hub's SSO bootstrap, and /api/resonance/ and
# /api/widgets/ are mounted by pages the hub itself renders — a blocked one of
# those reads as a broken feature rather than as Managed mode doing its job.
_LOCK_ALLOW_PREFIXES = (
    "/api/health", "/api/suite/", "/api/auth/", "/api/resonance/",
    "/api/widgets/", "/.well-known/", "/assets/",
)

# How long a lock outlives pktHub's last contact. pktHub polls health well
# inside this, so the only way to reach the expiry is for the hub to actually
# stop — at which point the lock releases rather than stranding this app behind
# a redirect to an address that no longer answers.
_LOCK_HEARTBEAT_MAX_AGE = 300  # seconds


@app.middleware("http")
async def _direct_access_lock(request: Request, call_next):
    """Send users to pktHub while it has this app in Managed mode.

    Failure here is deliberately silent: any error reading the lock falls
    through to serving the request. A bug in this middleware must not be able
    to take the app off the network, and the lock is a convenience for hub
    operators rather than a security boundary — every route keeps its own auth.
    """
    import aiosqlite, json, logging
    import secrets as _sec
    from datetime import datetime, timezone

    path = request.url.path
    if any(path == p or path.startswith(p) for p in _LOCK_ALLOW_PREFIXES):
        return await call_next(request)

    redirect_to = ""
    try:
        cfg = get_settings()
        # Every database touch finishes inside this block. Handing the request on
        # from within it would keep one connection open for the whole downstream
        # call, i.e. one per request in flight.
        async with aiosqlite.connect(cfg.db_path) as db:
            presented = request.headers.get("x-suite-token", "")
            stored    = (cfg.suite_token or "").strip()
            if presented and stored and _sec.compare_digest(presented, stored):
                # pktHub itself, or a user it is proxying — never redirected, and
                # its arrival is what keeps the lock alive.
                await db.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('lock_heartbeat_at', ?)",
                    (json.dumps(datetime.now(timezone.utc).isoformat()),)
                )
                await db.commit()
            else:
                async with db.execute("SELECT value FROM settings WHERE key='direct_ui_locked'") as cur:
                    row = await cur.fetchone()
                # "is True", not bool(): a value that failed to decode comes back
                # as the raw text, and bool("false") is True.
                if row and _decode_setting(row[0]) is True:
                    async with db.execute("SELECT value FROM settings WHERE key='lock_heartbeat_at'") as cur:
                        hrow = await cur.fetchone()
                    beat = _decode_setting(hrow[0]) if hrow else None
                    # No heartbeat at all counts as expired — a lock we cannot
                    # date is a lock we cannot trust to still be wanted.
                    expired = True
                    if beat:
                        try:
                            last = datetime.fromisoformat(str(beat))
                            if last.tzinfo is None:
                                last = last.replace(tzinfo=timezone.utc)
                            expired = (datetime.now(timezone.utc) - last).total_seconds() > _LOCK_HEARTBEAT_MAX_AGE
                        except ValueError:
                            pass

                    if expired:
                        logging.getLogger("pktsnmp.main").warning(
                            "pktHub has not called in %ss — releasing the direct-access lock",
                            _LOCK_HEARTBEAT_MAX_AGE,
                        )
                        await db.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_ui_locked', ?)",
                            (json.dumps(False),)
                        )
                        await db.commit()
                    else:
                        async with db.execute("SELECT value FROM settings WHERE key='hub_redirect_url'") as cur:
                            rrow = await cur.fetchone()
                        # No target means nowhere to send anyone — serve the app
                        # rather than bouncing users to a blank address.
                        redirect_to = str(_decode_setting(rrow[0]) or "") if rrow else ""
    except Exception:
        logging.getLogger("pktsnmp.main").exception("direct-access lock check failed")

    if redirect_to:
        return RedirectResponse(url=redirect_to, status_code=302)
    return await call_next(request)

# ── API Routers ───────────────────────────────────────────────────────────────

from app.api import alerts as alerts_router
from app.api import resonance as resonance_router
from app.api import resonance_data as resonance_data_router

app.include_router(auth.router,            prefix="/api/auth",     tags=["auth"])
app.include_router(users.router,           prefix="/api/users",    tags=["users"])
app.include_router(snmp_router.router,     prefix="/api/snmp",     tags=["snmp"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
app.include_router(system_router.router,   prefix="/api/system",   tags=["system"])
app.include_router(alerts_router.router,   prefix="/api/alerts",   tags=["alerts"])
app.include_router(logs_router.router,     prefix="/api/logs",     tags=["logs"])
app.include_router(suite_router.router, prefix="/api/suite", tags=["suite"])
app.include_router(user_api_keys_router.router, prefix="/api/user-api-keys", tags=["user-api-keys"])
app.include_router(ip_info_router.router,       prefix="/api/ip-info",       tags=["ip-info"])
app.include_router(mxtoolbox_router.router,     prefix="/api/mxtoolbox",     tags=["mxtoolbox"])
app.include_router(integrations_router.router,  prefix="/api/integrations",  tags=["integrations"])
app.include_router(widgets_router.router,       prefix="/api/widgets",       tags=["widgets"])
app.include_router(nav_router.router,           prefix="/api/nav",           tags=["nav"])
app.include_router(docs_router.router,          prefix="/api/docs-content",  tags=["docs"])
app.include_router(resonance_router.router,     prefix="/api/resonance",     tags=["resonance"])
# The assistant's data surface. Carries its own absolute paths — /api/resonance/data/*
# plus the two documents at /api/resonance/openapi.json and /.well-known/resonance.json —
# so it is mounted without a prefix, and before the SPA catch-all so the grant file wins
# over it.
app.include_router(resonance_data_router.router)
resonance_data_router.register_error_handler(app)
resonance_data_router.validate_grants(app)

# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["system"])
async def health(request: Request):
    """
    Also reports Managed-mode state. pktHub reads direct_ui_locked on every poll
    and flips its own record back to Direct when this app says it is unlocked,
    so the hub cannot go on showing a lock that the failsafe has released.

    The poll doubles as the lock's heartbeat — this request is the evidence that
    pktHub is still alive, which is why it answers even while locked.

    hub_redirect_url is deliberately not reported here. pktHub reads it from the
    token-authenticated /api/suite/direct-access, and this endpoint is public —
    an unlocked app has no reason to publish the hub's address to every caller.
    """
    import aiosqlite, json, logging
    import secrets as _sec
    from datetime import datetime, timezone

    locked = False
    try:
        cfg = get_settings()
        async with aiosqlite.connect(cfg.db_path) as db:
            async with db.execute("SELECT value FROM settings WHERE key='direct_ui_locked'") as cur:
                row = await cur.fetchone()
            locked = (_decode_setting(row[0]) is True) if row else False

            presented = request.headers.get("x-suite-token", "")
            stored    = (cfg.suite_token or "").strip()
            if presented and stored and _sec.compare_digest(presented, stored):
                await db.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('lock_heartbeat_at', ?)",
                    (json.dumps(datetime.now(timezone.utc).isoformat()),)
                )
                await db.commit()
    except Exception:
        logging.getLogger("pktsnmp.main").exception("health lock state read failed")

    return {"status": "ok", "version": "0.1.0", "direct_ui_locked": locked}

# ── Serve React frontend (production build) ───────────────────────────────────
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(request: Request, full_path: str):
        # /api/ and /.well-known/ are answered by real routes or not at all.
        # Falling through to index.html gave a 200 of HTML to anything asking
        # for a well-known document — resonance reading
        # /.well-known/resonance.json on an install that publishes none got a
        # page instead of an honest 404.
        if full_path.startswith("api/") or full_path.startswith(".well-known/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Normalize-then-prefix-check (CodeQL's own documented pattern for
        # py/path-injection) rather than pathlib's resolve()/is_relative_to,
        # which its Python taint tracker doesn't recognize as a sanitizer.
        _dist_root = os.path.normpath(str(_frontend_dist))
        _candidate = os.path.normpath(os.path.join(_dist_root, full_path))
        if not (_candidate == _dist_root or _candidate.startswith(_dist_root + os.sep)):
            # Path traversal attempt (e.g. "../../config.yaml") — refuse to
            # serve anything outside the frontend dist directory.
            raise HTTPException(status_code=404, detail="Not found")
        static_file = Path(_candidate)
        if static_file.exists() and static_file.is_file():
            return FileResponse(str(static_file))
        index = _frontend_dist / "index.html"
        response = FileResponse(str(index))
        # pktHub suite-token bootstrap — set sso cookies so React logs in automatically
        _cfg = settings
        _suite_tk = request.headers.get("x-suite-token", "")
        import secrets as _secrets
        if _suite_tk and _cfg.suite_token and _secrets.compare_digest(_suite_tk, _cfg.suite_token):
            from datetime import datetime, timedelta, timezone
            from jose import jwt as _jose_jwt
            from app.dependencies import _SUITE_ROLE_MAP
            _hub_user = request.headers.get("x-suite-user", "hub_user")
            _hub_role = request.headers.get("x-suite-role", "viewer")
            _local_role = _SUITE_ROLE_MAP.get(_hub_role, "viewer")
            _expire = datetime.now(tz=timezone.utc) + timedelta(hours=8)
            _payload = {"sub": "0", "role": _local_role, "exp": _expire, "type": "access"}
            _jwt = _jose_jwt.encode(_payload, _cfg.secret_key, algorithm=_cfg.algorithm)
            response.set_cookie("sso_access_token", _jwt,       max_age=60, httponly=False, samesite="lax")
            response.set_cookie("sso_role",         _local_role, max_age=60, httponly=False, samesite="lax")
        return response


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

    # When SSL is on, bind to the HTTPS port; otherwise bind to the HTTP port.
    _bind_port = settings.https_port if _ssl_enabled else settings.port

    _uvicorn_kwargs = dict(
        host=settings.host,
        port=_bind_port,
        log_level=settings.log_level.lower(),
        workers=1,
    )

    # SSL cert fallback: check settings.ssl_dir (where the UI's cert
    # upload/PFX-extract endpoints write server.crt/server.key)
    _ssl_dir = Path(settings.ssl_dir)
    if not _ssl_certfile and (_ssl_dir / "server.crt").exists():
        _ssl_certfile = str(_ssl_dir / "server.crt")
    if not _ssl_keyfile and (_ssl_dir / "server.key").exists():
        _ssl_keyfile = str(_ssl_dir / "server.key")

    if _ssl_enabled and _ssl_certfile and _ssl_keyfile:
        _uvicorn_kwargs["ssl_certfile"] = _ssl_certfile
        _uvicorn_kwargs["ssl_keyfile"]  = _ssl_keyfile
        log.info(f"Starting with HTTPS on port {_bind_port}: cert={_ssl_certfile}")
    else:
        log.info(f"Starting with HTTP on port {_bind_port} (no SSL configured)")

    uvicorn.run("app.main:app", **_uvicorn_kwargs)
