"""
SNMP API router -- credentials, collectors, devices, OID catalog, ingest, data queries.
"""
from __future__ import annotations

import base64
import json
import logging
import secrets
import time
from typing import Annotated, Any, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import AdminUser, AnalystUser, CurrentUser

log = logging.getLogger("pktsnmp.api.snmp")
router = APIRouter()

_MASK = "••••••••"
_V3_SECRET_FIELDS = {"auth_key_enc", "priv_key_enc"}


def _get_fernet():
    from cryptography.fernet import Fernet
    from app.config import get_settings
    key = get_settings().secret_key.encode()[:32].ljust(32, b"0")
    return Fernet(base64.urlsafe_b64encode(key))


def _encrypt(value: str) -> str:
    return _get_fernet().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    try:
        return _get_fernet().decrypt(value.encode()).decode()
    except Exception:
        return ""


_collector_bearer = HTTPBearer(auto_error=False)


async def _get_collector_by_token(token: str, db: aiosqlite.Connection) -> dict | None:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM collectors WHERE api_token=?", (token,)) as cur:
        row = await cur.fetchone()
    return dict(row) if row else None


async def collector_auth(
    request: Request,
    credentials: Annotated[Optional[HTTPAuthorizationCredentials], Security(_collector_bearer)] = None,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Collector token required")
    collector = await _get_collector_by_token(credentials.credentials, db)
    if not collector:
        # Track failure — match inbound IP to a collector so the UI can surface it
        client_ip = request.client.host if request.client else None
        if client_ip:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id FROM collectors WHERE ip=? OR ssh_host=?", (client_ip, client_ip)
            ) as cur:
                matched = await cur.fetchone()
            if matched:
                await db.execute(
                    "UPDATE collectors SET auth_failure_count = auth_failure_count + 1, "
                    "last_auth_failure_at = datetime('now'), updated_at = datetime('now') WHERE id=?",
                    (matched["id"],),
                )
                await db.commit()
        raise HTTPException(status_code=401, detail="Invalid collector token")
    # Good auth — reset any lingering failure state
    await db.execute(
        "UPDATE collectors SET auth_failure_count = 0, last_auth_failure_at = NULL, "
        "updated_at = datetime('now') WHERE id=?",
        (collector["id"],),
    )
    await db.commit()
    return collector


_SSH_SECRET_FIELDS = {"ssh_key_enc", "ssh_password_enc"}
_COLLECTOR_SSH_FIELDS = (
    "ssh_host", "ssh_port", "ssh_user", "ssh_auth_type",
    "ssh_key_enc", "ssh_password_enc",
    "otelcol_config_path", "otelcol_service",
    "sync_status", "last_synced_at", "last_sync_error",
)


def _mask_collector(collector: dict) -> dict:
    from datetime import datetime, timezone
    d = dict(collector)
    for field in _SSH_SECRET_FIELDS:
        if d.get(field):
            d[field] = _MASK          # "key saved" signal for the UI

    # Derive effective_status from observed health signals (not stored, computed each time)
    #   error   — recent auth failures (last_auth_failure_at within 15 min)
    #   offline — no recent OTLP ingest (last_seen null or older than 10 min)
    #   online  — data flowing normally
    now = datetime.now(timezone.utc)

    def _parse_utc(ts: str | None) -> datetime | None:
        if not ts:
            return None
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except Exception:
            return None

    failures = d.get("auth_failure_count") or 0
    last_fail = _parse_utc(d.get("last_auth_failure_at"))
    last_seen = _parse_utc(d.get("last_seen"))

    if failures > 0 and last_fail and (now - last_fail).total_seconds() < 900:
        effective = "error"
    elif last_seen and (now - last_seen).total_seconds() < 600:
        effective = "online"
    else:
        effective = "offline"

    d["effective_status"] = effective
    return d


def _mask_device(device: dict) -> dict:
    d = dict(device)
    for field in _V3_SECRET_FIELDS:
        if d.get(field):
            d[field] = _MASK
    return d


def _mask_credential(cred: dict) -> dict:
    d = dict(cred)
    for field in _V3_SECRET_FIELDS:
        if d.get(field):
            d[field] = _MASK
    return d


# ── Pydantic models ───────────────────────────────────────────────────────────

class CredentialCreate(BaseModel):
    name: str
    description: str = ""
    snmp_version: str = "v2c"
    community: str = "public"
    security_name: str = ""
    security_level: str = "noAuthNoPriv"
    auth_protocol: str = "SHA256"
    auth_key: str = ""
    priv_protocol: str = "AES128"
    priv_key: str = ""


class CredentialUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    snmp_version: str | None = None
    community: str | None = None
    security_name: str | None = None
    security_level: str | None = None
    auth_protocol: str | None = None
    auth_key: str | None = None
    priv_protocol: str | None = None
    priv_key: str | None = None


class CollectorCreate(BaseModel):
    name: str
    description: str = ""
    ip: str | None = None


class CollectorUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    ip: str | None = None
    status: str | None = None
    version: str | None = None


class CollectorSSHUpdate(BaseModel):
    """[Admin] Write SSH config for a remote collector. Key/password are write-only."""
    ssh_host: str | None = None             # override; defaults to collector.ip if blank
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_auth_type: str = "key"              # 'key' | 'password'
    ssh_key: str | None = None              # PEM text — encrypted at rest, never returned
    ssh_password: str | None = None        # plaintext — encrypted at rest, never returned
    otelcol_config_path: str = "/mnt/software/otel/config/otelcol-config.yaml"
    otelcol_service: str = "otelcol"


class DeviceCreate(BaseModel):
    name: str
    ip: str
    site: str = ""
    collector_id: int = 1
    credential_id: int | None = None
    poll_interval_override: int | None = None
    otelcol_label: str | None = None
    otelcol_pipeline: str | None = None    # e.g. 'metrics/switch', 'metrics/firewall'
    enabled: bool = True
    ha_role: str | None = None


class DeviceUpdate(BaseModel):
    name: str | None = None
    ip: str | None = None
    site: str | None = None
    collector_id: int | None = None
    credential_id: int | None = None
    poll_interval_override: int | None = None
    otelcol_label: str | None = None
    otelcol_pipeline: str | None = None
    enabled: bool | None = None
    ha_role: str | None = None


class OidCatalogCreate(BaseModel):
    oid: str
    name: str
    description: str = ""
    unit: str = ""
    data_type: str = "string"


class OidCatalogUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    unit: str | None = None
    data_type: str | None = None


# =============================================================================
# STATUS
# =============================================================================

@router.get("/status")
async def snmp_status(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT COUNT(*) AS total FROM devices") as cur:
        total_devices = (await cur.fetchone())["total"]
    async with db.execute("SELECT COUNT(*) AS up FROM devices WHERE status='up'") as cur:
        up_devices = (await cur.fetchone())["up"]
    async with db.execute("SELECT COUNT(*) AS down FROM devices WHERE status='down'") as cur:
        down_devices = (await cur.fetchone())["down"]
    async with db.execute("SELECT COUNT(*) AS total FROM collectors") as cur:
        total_collectors = (await cur.fetchone())["total"]
    async with db.execute(
        """SELECT COUNT(*) AS online FROM collectors
           WHERE (auth_failure_count = 0 OR last_auth_failure_at IS NULL
                  OR last_auth_failure_at < datetime('now', '-15 minutes'))
             AND last_seen IS NOT NULL
             AND last_seen >= datetime('now', '-10 minutes')"""
    ) as cur:
        online_collectors = (await cur.fetchone())["online"]
    async with db.execute("SELECT COUNT(*) AS total FROM snmp_credentials") as cur:
        total_creds = (await cur.fetchone())["total"]
    async with db.execute("SELECT COUNT(*) AS total FROM oid_catalog") as cur:
        total_oids = (await cur.fetchone())["total"]
    from app.storage.factory import get_storage
    storage_health = get_storage().health_check()
    return {
        "storage": storage_health,
        "devices": {"total": total_devices, "up": up_devices, "down": down_devices, "unknown": total_devices - up_devices - down_devices},
        "collectors": {"total": total_collectors, "online": online_collectors},
        "credentials": {"total": total_creds},
        "oid_catalog": {"total": total_oids},
    }


# =============================================================================
# CREDENTIALS
# =============================================================================

@router.get("/credentials")
async def list_credentials(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM snmp_credentials ORDER BY name") as cur:
        rows = await cur.fetchall()
    return [_mask_credential(dict(r)) for r in rows]


@router.get("/credentials/{cred_id}")
async def get_credential(cred_id: int, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM snmp_credentials WHERE id=?", (cred_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")
    return _mask_credential(dict(row))


@router.post("/credentials", status_code=201)
async def create_credential(body: CredentialCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    auth_key_enc = _encrypt(body.auth_key) if (body.auth_key and body.auth_key != _MASK) else None
    priv_key_enc = _encrypt(body.priv_key) if (body.priv_key and body.priv_key != _MASK) else None
    try:
        async with db.execute(
            """INSERT INTO snmp_credentials
                (name, description, snmp_version, community, security_name, security_level,
                 auth_protocol, auth_key_enc, priv_protocol, priv_key_enc)
               VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id""",
            (body.name, body.description, body.snmp_version, body.community,
             body.security_name, body.security_level, body.auth_protocol, auth_key_enc,
             body.priv_protocol, priv_key_enc),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail="Credential name already exists")
        raise
    return {"id": row[0], "name": body.name}


@router.put("/credentials/{cred_id}")
async def update_credential(cred_id: int, body: CredentialUpdate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM snmp_credentials WHERE id=?", (cred_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")
    d = dict(row)
    updates = body.model_dump(exclude_none=True)
    if "auth_key" in updates:
        val = updates.pop("auth_key")
        if val and val != _MASK:
            d["auth_key_enc"] = _encrypt(val)
    if "priv_key" in updates:
        val = updates.pop("priv_key")
        if val and val != _MASK:
            d["priv_key_enc"] = _encrypt(val)
    d.update(updates)
    await db.execute(
        """UPDATE snmp_credentials SET name=?, description=?, snmp_version=?, community=?,
            security_name=?, security_level=?, auth_protocol=?, auth_key_enc=?,
            priv_protocol=?, priv_key_enc=?, updated_at=datetime('now') WHERE id=?""",
        (d["name"], d["description"], d["snmp_version"], d["community"],
         d["security_name"], d["security_level"], d["auth_protocol"], d.get("auth_key_enc"),
         d["priv_protocol"], d.get("priv_key_enc"), cred_id),
    )
    await db.commit()
    return {"id": cred_id, "updated": True}


@router.delete("/credentials/{cred_id}", status_code=204)
async def delete_credential(cred_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute("SELECT COUNT(*) AS n FROM devices WHERE credential_id=?", (cred_id,)) as cur:
        used_by = (await cur.fetchone())[0]
    if used_by > 0:
        raise HTTPException(status_code=409, detail=f"Credential is used by {used_by} device(s) — reassign them first")
    async with db.execute("SELECT id FROM snmp_credentials WHERE id=?", (cred_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")
    await db.execute("DELETE FROM snmp_credentials WHERE id=?", (cred_id,))
    await db.commit()


# =============================================================================
# COLLECTORS
# =============================================================================

_COLLECTOR_SELECT = """
    SELECT id, name, description, ip, last_seen, status, version,
           ssh_host, ssh_port, ssh_user, ssh_auth_type,
           ssh_key_enc, ssh_password_enc,
           otelcol_config_path, otelcol_service,
           sync_status, last_synced_at, last_sync_error,
           auth_failure_count, last_auth_failure_at,
           created_at, updated_at
    FROM collectors
"""


@router.get("/collectors")
async def list_collectors(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(f"{_COLLECTOR_SELECT} ORDER BY id") as cur:
        rows = await cur.fetchall()
    return [_mask_collector(dict(r)) for r in rows]


@router.get("/collectors/{collector_id}")
async def get_collector(collector_id: int, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute(f"{_COLLECTOR_SELECT} WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    return _mask_collector(dict(row))


@router.post("/collectors", status_code=201)
async def create_collector(body: CollectorCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    token = secrets.token_urlsafe(32)
    try:
        async with db.execute(
            "INSERT INTO collectors (name, description, ip, api_token) VALUES (?,?,?,?) RETURNING id",
            (body.name, body.description, body.ip, token),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail="Collector name already exists")
        raise
    return {"id": row[0], "name": body.name, "description": body.description, "ip": body.ip,
            "api_token": token, "note": "Token shown once -- store it now"}


@router.put("/collectors/{collector_id}")
async def update_collector(collector_id: int, body: CollectorUpdate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM collectors WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    d = dict(row)
    d.update(body.model_dump(exclude_none=True))
    await db.execute(
        "UPDATE collectors SET name=?, description=?, ip=?, status=?, version=?, updated_at=datetime('now') WHERE id=?",
        (d["name"], d["description"], d["ip"], d["status"], d.get("version"), collector_id),
    )
    await db.commit()
    return {"id": collector_id, "updated": True}


@router.delete("/collectors/{collector_id}", status_code=204)
async def delete_collector(collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    if collector_id == 1:
        raise HTTPException(status_code=400, detail="Cannot delete the built-in local collector")
    async with db.execute("SELECT id FROM collectors WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    await db.execute("DELETE FROM collectors WHERE id=?", (collector_id,))
    await db.commit()


@router.post("/collectors/{collector_id}/rotate-token")
async def rotate_collector_token(collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    async with db.execute("SELECT id FROM collectors WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    new_token = secrets.token_urlsafe(32)
    await db.execute(
        "UPDATE collectors SET api_token=?, updated_at=datetime('now') WHERE id=?",
        (new_token, collector_id),
    )
    await db.commit()
    return {"id": collector_id, "api_token": new_token, "note": "Token shown once -- store it now"}


@router.put("/collectors/{collector_id}/ssh")
async def update_collector_ssh(
    collector_id: int, body: CollectorSSHUpdate, _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """[Admin] Save SSH config for a remote collector. Key/password are encrypted at rest."""
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM collectors WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    if collector_id == 1:
        raise HTTPException(status_code=400, detail="Built-in local collector does not need SSH config")

    d = dict(row)
    # Encrypt new key/password if provided; keep existing if not provided
    if body.ssh_key and body.ssh_key != _MASK:
        d["ssh_key_enc"] = _encrypt(body.ssh_key)
    if body.ssh_password and body.ssh_password != _MASK:
        d["ssh_password_enc"] = _encrypt(body.ssh_password)

    await db.execute(
        """UPDATE collectors SET
            ssh_host=?, ssh_port=?, ssh_user=?, ssh_auth_type=?,
            ssh_key_enc=?, ssh_password_enc=?,
            otelcol_config_path=?, otelcol_service=?,
            updated_at=datetime('now')
           WHERE id=?""",
        (
            body.ssh_host or d.get("ssh_host"),
            body.ssh_port,
            body.ssh_user or d.get("ssh_user"),
            body.ssh_auth_type,
            d.get("ssh_key_enc"),
            d.get("ssh_password_enc"),
            body.otelcol_config_path,
            body.otelcol_service,
            collector_id,
        ),
    )
    await db.commit()
    return {"id": collector_id, "updated": True}


@router.delete("/collectors/{collector_id}/ssh-key")
async def delete_collector_ssh_key(
    collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """[Admin] Remove stored SSH key for a collector."""
    async with db.execute("SELECT id FROM collectors WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    await db.execute(
        "UPDATE collectors SET ssh_key_enc=NULL, updated_at=datetime('now') WHERE id=?",
        (collector_id,),
    )
    await db.commit()
    return {"id": collector_id, "ssh_key_enc": None}


@router.post("/collectors/{collector_id}/test-ssh")
async def test_collector_ssh(
    collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """[Admin] Verify SSH reachability of a remote collector. Does not modify anything."""
    db.row_factory = aiosqlite.Row
    async with db.execute(f"{_COLLECTOR_SELECT} WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    if collector_id == 1:
        raise HTTPException(status_code=400, detail="Built-in local collector is not reachable via SSH")
    c = dict(row)
    key_pem = _decrypt(c["ssh_key_enc"]) if c.get("ssh_key_enc") else None
    password = _decrypt(c["ssh_password_enc"]) if c.get("ssh_password_enc") else None
    import asyncio as _asyncio
    from app.snmp.collector_push import test_ssh
    return await _asyncio.to_thread(test_ssh, c, key_pem, password)


@router.get("/collectors/{collector_id}/preview-config")
async def preview_collector_config(
    collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """[Admin] Generate and return the YAML that would be pushed (dry-run)."""
    db.row_factory = aiosqlite.Row
    async with db.execute(f"{_COLLECTOR_SELECT} WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    if collector_id == 1:
        raise HTTPException(status_code=400, detail="Built-in local collector config is managed in-process")
    c = dict(row)
    key_pem  = _decrypt(c["ssh_key_enc"]) if c.get("ssh_key_enc") else None
    password = _decrypt(c["ssh_password_enc"]) if c.get("ssh_password_enc") else None
    devices_with_creds = await _load_devices_for_push(collector_id, db)
    import asyncio as _asyncio
    from app.snmp.collector_push import preview_config
    yaml_text = await _asyncio.to_thread(preview_config, c, devices_with_creds, key_pem, password)
    return {"yaml": yaml_text}


@router.post("/collectors/{collector_id}/sync")
async def sync_collector(
    collector_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """[Admin] Push current SNMP device config to a remote otelcol collector."""
    db.row_factory = aiosqlite.Row
    async with db.execute(f"{_COLLECTOR_SELECT} WHERE id=?", (collector_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collector not found")
    if collector_id == 1:
        raise HTTPException(status_code=400, detail="Built-in local collector is managed in-process — no push needed")
    c = dict(row)
    key_pem  = _decrypt(c["ssh_key_enc"]) if c.get("ssh_key_enc") else None
    password = _decrypt(c["ssh_password_enc"]) if c.get("ssh_password_enc") else None
    devices_with_creds = await _load_devices_for_push(collector_id, db)
    import asyncio as _asyncio
    from app.snmp.collector_push import push_config
    result = await _asyncio.to_thread(push_config, c, devices_with_creds, key_pem, password)
    # Update sync status
    if result["ok"]:
        await db.execute(
            "UPDATE collectors SET sync_status='synced', last_synced_at=datetime('now'), last_sync_error=NULL, updated_at=datetime('now') WHERE id=?",
            (collector_id,),
        )
    else:
        await db.execute(
            "UPDATE collectors SET sync_status='error', last_sync_error=?, updated_at=datetime('now') WHERE id=?",
            (result.get("message", "Unknown error")[:500], collector_id),
        )
    await db.commit()
    return result


async def _load_devices_for_push(collector_id: int, db: aiosqlite.Connection) -> list[dict]:
    """Load all enabled devices for a collector, with decrypted SNMP credentials merged in."""
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT d.id, d.name, d.ip, d.otelcol_label, d.otelcol_pipeline,
                  d.poll_interval_override,
                  COALESCE(NULLIF(d.snmp_version, ''), c.snmp_version, 'v2c') AS snmp_version,
                  COALESCE(NULLIF(d.community, ''), c.community, 'public') AS community,
                  COALESCE(NULLIF(d.security_name, ''), c.security_name, '') AS security_name,
                  COALESCE(NULLIF(d.security_level, ''), c.security_level, 'noAuthNoPriv') AS security_level,
                  COALESCE(NULLIF(d.auth_protocol, ''), c.auth_protocol, 'SHA256') AS auth_protocol,
                  COALESCE(d.auth_key_enc, c.auth_key_enc) AS auth_key_enc,
                  COALESCE(NULLIF(d.priv_protocol, ''), c.priv_protocol, 'AES128') AS priv_protocol,
                  COALESCE(d.priv_key_enc, c.priv_key_enc) AS priv_key_enc
           FROM devices d
           LEFT JOIN snmp_credentials c ON c.id = d.credential_id
           WHERE d.collector_id=? AND d.enabled=1 AND d.otelcol_label IS NOT NULL""",
        (collector_id,),
    ) as cur:
        rows = await cur.fetchall()
    result = []
    for row in rows:
        d = dict(row)
        # Decrypt SNMP auth/priv keys for otelcol config generation
        if d.get("auth_key_enc"):
            try:
                d["auth_key"] = _decrypt(d["auth_key_enc"])
            except Exception:
                d["auth_key"] = ""
        else:
            d["auth_key"] = ""
        if d.get("priv_key_enc"):
            try:
                d["priv_key"] = _decrypt(d["priv_key_enc"])
            except Exception:
                d["priv_key"] = ""
        else:
            d["priv_key"] = ""
        result.append(d)
    return result


# =============================================================================
# DEVICES
# =============================================================================

_DEVICE_SELECT = """
    SELECT d.id, d.name, d.ip, d.site, d.collector_id, d.credential_id,
           d.poll_interval_override, d.last_seen, d.status, d.last_error,
           d.otelcol_label, d.otelcol_pipeline, d.enabled, d.ha_role,
           d.created_at, d.updated_at,
           d.snmp_version AS device_snmp_version,
           d.community AS device_community,
           col.name AS collector_name,
           cred.name AS credential_name,
           cred.snmp_version AS cred_snmp_version,
           cred.community AS cred_community,
           cred.security_level AS cred_security_level
    FROM devices d
    LEFT JOIN collectors col ON col.id = d.collector_id
    LEFT JOIN snmp_credentials cred ON cred.id = d.credential_id
"""


@router.get("/devices")
async def list_devices(
    _: CurrentUser,
    collector_id: int | None = Query(None),
    site: str | None = Query(None),
    enabled: bool | None = Query(None),
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    conditions: list[str] = []
    params: list[Any] = []
    if collector_id is not None:
        conditions.append("d.collector_id=?"); params.append(collector_id)
    if site:
        conditions.append("d.site=?"); params.append(site)
    if enabled is not None:
        conditions.append("d.enabled=?"); params.append(1 if enabled else 0)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"{_DEVICE_SELECT} {where} ORDER BY d.id"
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/devices/{device_id}")
async def get_device(device_id: int, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    sql = f"{_DEVICE_SELECT} WHERE d.id=?"
    async with db.execute(sql, (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    return dict(row)


@router.post("/devices", status_code=201)
async def create_device(body: DeviceCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    try:
        async with db.execute(
            """INSERT INTO devices
                (name, ip, site, collector_id, credential_id,
                 poll_interval_override, otelcol_label, otelcol_pipeline, enabled, ha_role)
               VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id""",
            (body.name, body.ip, body.site, body.collector_id, body.credential_id,
             body.poll_interval_override, body.otelcol_label, body.otelcol_pipeline,
             1 if body.enabled else 0, body.ha_role),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail="Device IP already registered")
        raise
    _signal_reload()
    return {"id": row[0], "name": body.name, "ip": body.ip}


@router.put("/devices/{device_id}")
async def update_device(device_id: int, body: DeviceUpdate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    d = dict(row)
    d.update(body.model_dump(exclude_none=True))
    await db.execute(
        """UPDATE devices SET name=?, ip=?, site=?, collector_id=?, credential_id=?,
            poll_interval_override=?, otelcol_label=?, otelcol_pipeline=?,
            enabled=?, ha_role=?, updated_at=datetime('now') WHERE id=?""",
        (d.get("name"), d.get("ip"), d.get("site"), d.get("collector_id"), d.get("credential_id"),
         d.get("poll_interval_override"), d.get("otelcol_label"), d.get("otelcol_pipeline"),
         d.get("enabled"), d.get("ha_role"), device_id),
    )
    await db.commit()
    _signal_reload()
    return {"id": device_id, "updated": True}


@router.delete("/devices/{device_id}", status_code=204)
async def delete_device(device_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute("SELECT id FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    await db.execute("DELETE FROM devices WHERE id=?", (device_id,))
    await db.commit()
    _signal_reload()


@router.post("/devices/{device_id}/test")
async def test_device(device_id: int, _: AnalystUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT d.id, d.ip,
               COALESCE(c.snmp_version, 'v2c') AS snmp_version,
               COALESCE(c.community, 'public') AS community,
               COALESCE(c.security_name, '') AS security_name,
               COALESCE(c.security_level, 'noAuthNoPriv') AS security_level,
               COALESCE(c.auth_protocol, 'SHA256') AS auth_protocol,
               c.auth_key_enc, c.priv_key_enc
           FROM devices d
           LEFT JOIN snmp_credentials c ON c.id = d.credential_id
           WHERE d.id=?""",
        (device_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    device = dict(row)
    try:
        from pysnmp.hlapi.asyncio import (
            getCmd, SnmpEngine, CommunityData, UsmUserData,
            UdpTransportTarget, ContextData, ObjectType, ObjectIdentity,
            usmHMACSHAAuthProtocol, usmHMACSHA256AuthProtocol, usmAesCfb128Protocol,
        )
        engine = SnmpEngine()
        target = UdpTransportTarget((device["ip"], 161), timeout=5, retries=1)
        ctx = ContextData()
        if device["snmp_version"] == "v3":
            auth_key = _decrypt(device["auth_key_enc"]) if device.get("auth_key_enc") else None
            priv_key = _decrypt(device["priv_key_enc"]) if device.get("priv_key_enc") else None
            auth_proto = usmHMACSHA256AuthProtocol if "256" in (device.get("auth_protocol") or "SHA256") else usmHMACSHAAuthProtocol
            auth_data = UsmUserData(device.get("security_name") or "", authKey=auth_key, privKey=priv_key,
                                     authProtocol=auth_proto, privProtocol=usmAesCfb128Protocol)
        else:
            auth_data = CommunityData(device.get("community") or "public")
        start = time.monotonic()
        error_indication, error_status, _, var_binds = await getCmd(
            engine, auth_data, target, ctx, ObjectType(ObjectIdentity("1.3.6.1.2.1.1.1.0")),
        )
        latency_ms = int((time.monotonic() - start) * 1000)
        if error_indication:
            return {"device_id": device_id, "ip": device["ip"], "success": False, "error": str(error_indication), "latency_ms": latency_ms}
        if error_status:
            return {"device_id": device_id, "ip": device["ip"], "success": False, "error": str(error_status), "latency_ms": latency_ms}
        sys_descr = str(var_binds[0][1]) if var_binds else ""
        return {"device_id": device_id, "ip": device["ip"], "success": True, "sys_descr": sys_descr, "latency_ms": latency_ms}
    except Exception as e:
        return {"device_id": device_id, "ip": device["ip"], "success": False, "error": str(e), "latency_ms": None}


# =============================================================================
# OID CATALOG
# =============================================================================

@router.get("/oids")
async def list_oids(_: CurrentUser, source: str | None = Query(None), data_type: str | None = Query(None), db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    db.row_factory = aiosqlite.Row
    conditions: list[str] = []
    params: list[Any] = []
    if source:
        conditions.append("source=?"); params.append(source)
    if data_type:
        conditions.append("data_type=?"); params.append(data_type)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    async with db.execute(f"SELECT * FROM oid_catalog {where} ORDER BY oid", params) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/oids/{oid_id}")
async def get_oid(oid_id: int, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM oid_catalog WHERE id=?", (oid_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="OID not found")
    return dict(row)


@router.post("/oids", status_code=201)
async def create_oid(body: OidCatalogCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    try:
        async with db.execute(
            "INSERT INTO oid_catalog (oid, name, description, unit, data_type, source) VALUES (?,?,?,?,?,'user') RETURNING id",
            (body.oid, body.name, body.description, body.unit, body.data_type),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail="OID already exists")
        raise
    return {"id": row[0], "oid": body.oid, "name": body.name}


@router.put("/oids/{oid_id}")
async def update_oid(oid_id: int, body: OidCatalogUpdate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM oid_catalog WHERE id=?", (oid_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="OID not found")
    d = dict(row)
    d.update(body.model_dump(exclude_none=True))
    await db.execute("UPDATE oid_catalog SET name=?, description=?, unit=?, data_type=? WHERE id=?",
                     (d["name"], d["description"], d["unit"], d["data_type"], oid_id))
    await db.commit()
    return {"id": oid_id, "updated": True}


@router.delete("/oids/{oid_id}", status_code=204)
async def delete_oid(oid_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, source FROM oid_catalog WHERE id=?", (oid_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="OID not found")
    if dict(row)["source"] == "bundled":
        raise HTTPException(status_code=400, detail="Cannot delete bundled OIDs")
    await db.execute("DELETE FROM oid_catalog WHERE id=?", (oid_id,))
    await db.commit()


# =============================================================================
# INGEST
# =============================================================================

async def _do_ingest_otlp(request: Request, collector: dict, db: aiosqlite.Connection) -> dict:
    """Shared handler for OTLP metric ingest."""
    import gzip as _gzip, json as _json
    raw = await request.body()
    if raw[:2] == b'\x1f\x8b':
        raw = _gzip.decompress(raw)
    body = _json.loads(raw)
    from app.snmp.parser import parse_otlp_metrics
    from app.storage.factory import get_storage
    results = parse_otlp_metrics(body, collector["id"])
    storage = get_storage()
    db.row_factory = aiosqlite.Row
    device_cache: dict[str, tuple] = {}
    for result in results:
        label = result.get("device_label", "")
        if label not in device_cache:
            async with db.execute(
                "SELECT id, ip FROM devices WHERE collector_id=? AND otelcol_label=?",
                (collector["id"], label),
            ) as cur:
                device = await cur.fetchone()
            device_cache[label] = (
                device["id"] if device else None,
                device["ip"] if device else label,
            )
        result["device_id"], result["device_ip"] = device_cache[label]
    await storage.ingest_poll_results_bulk(results)
    device_ids = {v[0] for v in device_cache.values() if v[0] is not None}
    for device_id in device_ids:
        await db.execute(
            "UPDATE devices SET status='up', last_seen=datetime('now'), "
            "updated_at=datetime('now') WHERE id=?",
            (device_id,),
        )
    await db.execute(
        "UPDATE collectors SET last_seen=datetime('now'), status='online', updated_at=datetime('now') WHERE id=?",
        (collector["id"],),
    )
    await db.commit()
    return {"accepted": len(results)}


@router.post("/ingest/otlp", status_code=202)
async def ingest_otlp(request: Request, collector: dict = Depends(collector_auth), db: aiosqlite.Connection = Depends(get_db)) -> dict:
    return await _do_ingest_otlp(request, collector, db)


@router.post("/ingest/otlp/v1/metrics", status_code=202)
async def ingest_otlp_v1_metrics(request: Request, collector: dict = Depends(collector_auth), db: aiosqlite.Connection = Depends(get_db)) -> dict:
    return await _do_ingest_otlp(request, collector, db)


@router.post("/ingest/heartbeat", status_code=200)
async def ingest_heartbeat(body: dict, collector: dict = Depends(collector_auth), db: aiosqlite.Connection = Depends(get_db)) -> dict:
    await db.execute(
        "UPDATE collectors SET last_seen=datetime('now'), status='online', version=?, "
        "auth_failure_count=0, last_auth_failure_at=NULL, updated_at=datetime('now') WHERE id=?",
        (body.get("version"), collector["id"]),
    )
    await db.commit()
    return {"ok": True}


# =============================================================================
# DATA QUERIES
# =============================================================================

@router.get("/traps")
async def list_traps(
    _: CurrentUser,
    collector_id: int | None = Query(None),
    device_ip: str | None = Query(None),
    since: str | None = Query(None),
    limit: int = Query(100, ge=1, le=5000),
) -> list[dict]:
    from app.storage.factory import get_storage
    return await get_storage().query_traps(collector_id=collector_id, device_ip=device_ip, since=since, limit=limit)


@router.get("/poll-history")
async def poll_history(
    _: CurrentUser,
    device_id: int | None = Query(None),
    oid_label: str | None = Query(None),
    since: str | None = Query(None),
    limit: int = Query(1000, ge=1, le=50000),
) -> list[dict]:
    from app.storage.factory import get_storage
    return await get_storage().query_poll_history(device_id=device_id, oid_label=oid_label, since=since, limit=limit)


@router.get("/devices/{device_id}/latest")
async def device_latest(device_id: int, _: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    async with db.execute("SELECT id FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    from app.storage.factory import get_storage
    return await get_storage().get_device_latest(device_id)


# =============================================================================
# CLEANUP
# =============================================================================

@router.post("/cleanup")
async def run_cleanup(_: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT value FROM settings WHERE key='retention_days_raw'") as cur:
        row = await cur.fetchone()
    retention_days = json.loads(row[0]) if row else 90
    from app.storage.factory import get_storage
    return await get_storage().run_cleanup(retention_days)


@router.get("/dashboard")
async def snmp_dashboard(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    trap_timeline: list[dict] = []
    top_sources:   list[dict] = []
    recent_traps:  list[dict] = []
    try:
        from app.storage.factory import get_storage
        storage = get_storage()
        if hasattr(storage, '_conn'):
            conn = storage._conn
            tl_rows = conn.execute("""
                SELECT date_trunc('hour', received_at) AS hr, COUNT(*) AS n
                FROM snmp_traps
                WHERE received_at >= now() - INTERVAL '24 hours'
                GROUP BY hr ORDER BY hr
            """).fetchall()
            trap_timeline = [{"hour": str(r[0]), "count": int(r[1])} for r in tl_rows]
            ts_rows = conn.execute("""
                SELECT source_ip, COUNT(*) AS n
                FROM snmp_traps
                WHERE received_at >= now() - INTERVAL '24 hours'
                GROUP BY source_ip ORDER BY n DESC LIMIT 10
            """).fetchall()
            top_sources = [{"source_ip": r[0] or "unknown", "count": int(r[1])} for r in ts_rows]
            rt_rows = conn.execute("""
                SELECT received_at, source_ip, trap_oid, snmp_version
                FROM snmp_traps ORDER BY received_at DESC LIMIT 10
            """).fetchall()
            recent_traps = [
                {"received_at": str(r[0]), "source_ip": r[1] or "", "trap_oid": r[2] or "", "snmp_version": r[3] or ""}
                for r in rt_rows
            ]
    except Exception:
        pass
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT COUNT(*) AS n FROM devices") as cur:
        devices_total = (await cur.fetchone())["n"]
    async with db.execute("SELECT COUNT(*) AS n FROM devices WHERE status='up'") as cur:
        devices_up = (await cur.fetchone())["n"]
    async with db.execute("SELECT COUNT(*) AS n FROM devices WHERE status='down'") as cur:
        devices_down = (await cur.fetchone())["n"]
    async with db.execute("SELECT COUNT(*) AS n FROM alert_events WHERE acked_at IS NULL") as cur:
        active_alerts = (await cur.fetchone())["n"]
    traps_24h = sum(s["count"] for s in top_sources)
    return {
        "trap_timeline": trap_timeline,
        "top_sources": top_sources,
        "recent_traps": recent_traps,
        "active_alerts": active_alerts,
        "devices": {
            "total": devices_total,
            "up": devices_up,
            "down": devices_down,
            "unknown": max(0, devices_total - devices_up - devices_down),
        },
        "traps_24h": traps_24h,
    }


def _signal_reload() -> None:
    try:
        from app.main import app  # type: ignore[import]
        if hasattr(app.state, "local_collector"):
            app.state.local_collector.signal_reload()
    except Exception:
        pass
