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
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Security, UploadFile, status
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


_CRED_SECRET_FIELDS = {"auth_key_enc", "priv_key_enc", "community"}


def _mask_credential(cred: dict) -> dict:
    d = dict(cred)
    for field in _CRED_SECRET_FIELDS:
        if d.get(field) is not None:
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
    org: str = ""          # Org (top level)
    groups: str = ""       # Group (second level; 'group' is a SQL keyword so column is 'groups')
    site: str = ""         # Site (third level; was 'location' before migration 011)
    device_type: str = ""  # firewall|switch|wap|wlc|router|iot|ups|server|storage|pdu|camera|load_balancer|vpn|printer|other|''
    collector_id: int = 1
    credential_id: int | None = None
    poll_interval_override: int | None = None
    otelcol_label: str | None = None
    otelcol_pipeline: str | None = None    # e.g. 'metrics/switch', 'metrics/firewall'
    enabled: bool = True
    parent_device_id: int | None = None
    ha_role: str | None = None   # 'active' | 'passive' | 'standalone' | None
    ha_peer_id: int | None = None  # ID of the HA partner device


class DeviceUpdate(BaseModel):
    name: str | None = None
    ip: str | None = None
    org: str | None = None
    groups: str | None = None
    site: str | None = None
    device_type: str | None = None
    collector_id: int | None = None
    credential_id: int | None = None
    poll_interval_override: int | None = None
    otelcol_label: str | None = None
    otelcol_pipeline: str | None = None
    enabled: bool | None = None
    parent_device_id: int | None = None
    ha_role: str | None = None   # 'active' | 'passive' | 'standalone' | None
    ha_peer_id: int | None = None  # ID of the HA partner device


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
    # community is masked in GET responses — only update if a real value was sent
    if "community" in updates and updates["community"] == _MASK:
        updates.pop("community")
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
    SELECT d.id, d.name, d.ip, d.org, d.groups, d.site, d.device_type,
           d.collector_id, d.credential_id,
           d.poll_interval_override, d.last_seen, d.status, d.last_error,
           d.otelcol_label, d.otelcol_pipeline, d.enabled, d.created_at, d.updated_at,
           d.parent_device_id, d.ha_role, d.ha_peer_id,
           d.snmp_version AS device_snmp_version,
           d.community AS device_community,
           col.name AS collector_name,
           cred.name AS credential_name,
           cred.snmp_version AS cred_snmp_version,
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
        conditions.append("d.groups=?"); params.append(site)
    if enabled is not None:
        conditions.append("d.enabled=?"); params.append(1 if enabled else 0)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"{_DEVICE_SELECT} {where} ORDER BY d.id"
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/devices/tree")
async def device_tree(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    """Return the full environment tree: Org → Group → Site → Root Devices → Child Devices.

    DB columns: org (Org), site (Group in UI), location (Site in UI).
    Virtual grouping node types: 'org', 'group', 'site'.
    Device nodes: type='device'. Passive HA devices hidden; children redirect to active peer.
    """
    from collections import defaultdict
    db.row_factory = aiosqlite.Row

    # Fetch ALL devices (passive too) to build peer map
    async with db.execute(
        """SELECT id, name, ip, org, groups, site, device_type, status, enabled,
                  parent_device_id, ha_role, ha_peer_id, last_seen
           FROM devices ORDER BY name"""
    ) as cur:
        device_rows = await cur.fetchall()

    # peer_map: passive_id → active_id
    peer_map: dict[int, int] = {}
    for r in device_rows:
        if r["ha_role"] not in (None, "active", "standalone") and r["ha_peer_id"]:
            peer_map[r["id"]] = r["ha_peer_id"]

    # Display-worthy: non-passive devices only
    display_ids = {r["id"] for r in device_rows
                   if r["ha_role"] is None or r["ha_role"] in ("active", "standalone")}

    # Build flat node map
    nodes: dict[int, dict] = {}
    for r in device_rows:
        if r["id"] not in display_ids:
            continue
        is_down = (r["status"] == "down") and bool(r["enabled"])
        nodes[r["id"]] = {
            "type": "device",
            "id": r["id"],
            "name": r["name"],
            "ip": r["ip"],
            "org": r["org"] or "",
            "groups": r["groups"] or "",      # "Group" in UI
            "site": r["site"] or "",          # "Site" in UI
            "device_type": r["device_type"] or "",
            "status": r["status"] or "unknown",
            "enabled": bool(r["enabled"]),
            "parent_device_id": r["parent_device_id"],
            "ha_role": r["ha_role"],
            "ha_peer_id": r["ha_peer_id"],
            "last_seen": r["last_seen"],
            "direct_alerts": 1 if is_down else 0,
            "subtree_alerts": 1 if is_down else 0,
            "children": [],
        }

    # Wire device parent → child; passive parents redirect to active peer
    device_roots: list[dict] = []
    for node in nodes.values():
        pid = node["parent_device_id"]
        if pid in peer_map:
            pid = peer_map[pid]
        if pid and pid in nodes:
            nodes[pid]["children"].append(node)
        else:
            device_roots.append(node)

    # Post-order DFS: propagate subtree_alerts up through device trees
    def _propagate(node: dict) -> int:
        total = node["direct_alerts"]
        for child in node["children"]:
            total += _propagate(child)
        node["subtree_alerts"] = total
        return total

    for root in device_roots:
        _propagate(root)

    # Group root devices: org → groups (Group) → site (Site)
    tree: dict[str, dict[str, dict[str, list[dict]]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for dev in device_roots:
        org  = dev["org"] or "(Unassigned)"
        grp  = dev["groups"] or "(Unassigned)"
        site = dev["site"] or "(Unassigned)"
        tree[org][grp][site].append(dev)

    result: list[dict] = []
    for org_name in sorted(tree):
        org_alerts = 0
        org_children: list[dict] = []
        for grp_name in sorted(tree[org_name]):
            grp_alerts = 0
            grp_children: list[dict] = []
            for site_name in sorted(tree[org_name][grp_name]):
                devs = tree[org_name][grp_name][site_name]
                site_alerts = sum(d["subtree_alerts"] for d in devs)
                grp_children.append({
                    "type": "site",
                    "name": site_name,
                    "direct_alerts": 0,
                    "subtree_alerts": site_alerts,
                    "children": devs,
                })
                grp_alerts += site_alerts
            org_children.append({
                "type": "group",
                "name": grp_name,
                "direct_alerts": 0,
                "subtree_alerts": grp_alerts,
                "children": grp_children,
            })
            org_alerts += grp_alerts
        result.append({
            "type": "org",
            "name": org_name,
            "direct_alerts": 0,
            "subtree_alerts": org_alerts,
            "children": org_children,
        })

    return result


@router.get("/devices/export")
async def export_devices(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Export all devices as a CSV file download."""
    import csv
    import io
    from fastapi.responses import StreamingResponse

    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT d.name, d.ip, d.org, d.groups, d.site, d.device_type,
                  d.otelcol_label, d.enabled, d.poll_interval_override, d.ha_role,
                  col.name AS collector_name,
                  cred.name AS credential_name
           FROM devices d
           LEFT JOIN collectors col ON col.id = d.collector_id
           LEFT JOIN snmp_credentials cred ON cred.id = d.credential_id
           ORDER BY d.name"""
    ) as cur:
        rows = await cur.fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "name", "ip", "org", "groups", "site", "device_type",
        "otelcol_label", "enabled", "poll_interval_override",
        "ha_role", "collector_name", "credential_name",
    ])
    for r in rows:
        writer.writerow([
            r["name"], r["ip"],
            r["org"] or "", r["groups"] or "", r["site"] or "", r["device_type"] or "",
            r["otelcol_label"] or "",
            "true" if r["enabled"] else "false",
            r["poll_interval_override"] if r["poll_interval_override"] is not None else "",
            r["ha_role"] or "",
            r["collector_name"] or "", r["credential_name"] or "",
        ])
    buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="pktsnmp-devices.csv"'},
    )


@router.post("/devices/import-csv")
async def import_devices_csv(
    file: UploadFile,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    """Import devices from a multipart CSV upload.

    CSV columns (header row required):
      name, ip, org, groups, site, device_type, otelcol_label, enabled,
      poll_interval_override, ha_role, collector_name, credential_name

    - Rows are inserted; duplicate IPs are skipped (not updated).
    - collector_name and credential_name are matched by name (case-sensitive).
      Unknown collector_name defaults to the built-in local collector (id=1).
      Unknown credential_name leaves credential_id as NULL.
    """
    import csv, io

    raw = await file.read()
    text = raw.decode("utf-8-sig")  # strip BOM (Excel exports)

    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, name FROM collectors") as cur:
        col_map = {r["name"]: r["id"] for r in await cur.fetchall()}
    async with db.execute("SELECT id, name FROM snmp_credentials") as cur:
        cred_map = {r["name"]: r["id"] for r in await cur.fetchall()}

    reader = csv.DictReader(io.StringIO(text))
    created = 0
    skipped = 0
    errors: list[str] = []

    for lineno, row in enumerate(reader, start=2):
        name = (row.get("name") or "").strip()
        ip   = (row.get("ip") or "").strip()
        if not name or not ip:
            errors.append(f"Row {lineno}: missing name or ip — skipped")
            skipped += 1
            continue

        col_name  = (row.get("collector_name") or "").strip()
        cred_name = (row.get("credential_name") or "").strip()
        collector_id  = col_map.get(col_name, 1)
        credential_id = cred_map.get(cred_name)

        enabled_str = (row.get("enabled") or "true").strip().lower()
        enabled = enabled_str not in ("false", "0", "no")

        poll_str = (row.get("poll_interval_override") or "").strip()
        poll_override = int(poll_str) if poll_str.lstrip("-").isdigit() else None

        ha_role = (row.get("ha_role") or "").strip() or None
        if ha_role not in (None, "active", "passive", "standalone"):
            ha_role = None

        try:
            async with db.execute(
                """INSERT OR IGNORE INTO devices
                    (name, ip, org, groups, site, device_type, otelcol_label,
                     enabled, poll_interval_override, ha_role,
                     collector_id, credential_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id""",
                (
                    name, ip,
                    (row.get("org") or "").strip(),
                    (row.get("groups") or "").strip(),
                    (row.get("site") or "").strip(),
                    (row.get("device_type") or "").strip(),
                    (row.get("otelcol_label") or "").strip() or None,
                    1 if enabled else 0,
                    poll_override,
                    ha_role,
                    collector_id,
                    credential_id,
                ),
            ) as cur:
                result_row = await cur.fetchone()
            if result_row:
                created += 1
            else:
                skipped += 1
                errors.append(f"Row {lineno}: {name} ({ip}) already exists — skipped")
        except Exception as exc:
            errors.append(f"Row {lineno}: {name} ({ip}): {exc}")
            skipped += 1

    await db.commit()
    _signal_reload()
    return {"created": created, "skipped": skipped, "errors": errors}


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
                (name, ip, org, groups, site, device_type, collector_id, credential_id,
                 poll_interval_override, otelcol_label, otelcol_pipeline, enabled,
                 parent_device_id, ha_role, ha_peer_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id""",
            (body.name, body.ip, body.org, body.groups, body.site, body.device_type,
             body.collector_id, body.credential_id,
             body.poll_interval_override, body.otelcol_label, body.otelcol_pipeline,
             1 if body.enabled else 0, body.parent_device_id, body.ha_role, body.ha_peer_id),
        ) as cur:
            row = await cur.fetchone()
        new_id = row[0]
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail="Device IP already registered")
        raise
    # Bidirectional HA peer link
    if body.ha_peer_id:
        await db.execute(
            "UPDATE devices SET ha_peer_id=? WHERE id=?", (new_id, body.ha_peer_id)
        )
        await db.commit()
    _signal_reload()
    return {"id": new_id, "name": body.name, "ip": body.ip}


@router.put("/devices/{device_id}")
async def update_device(device_id: int, body: DeviceUpdate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    d = dict(row)
    # Handle parent_device_id explicitly — it can be set to None intentionally
    updates = body.model_dump(exclude_unset=True)
    d.update(updates)
    new_peer_id = d.get("ha_peer_id")
    await db.execute(
        """UPDATE devices SET name=?, ip=?, org=?, groups=?, site=?, device_type=?,
            collector_id=?, credential_id=?,
            poll_interval_override=?, otelcol_label=?, otelcol_pipeline=?,
            enabled=?, parent_device_id=?, ha_role=?, ha_peer_id=?,
            updated_at=datetime('now') WHERE id=?""",
        (d.get("name"), d.get("ip"), d.get("org", ""), d.get("groups", ""), d.get("site", ""),
         d.get("device_type", ""), d.get("collector_id"), d.get("credential_id"),
         d.get("poll_interval_override"), d.get("otelcol_label"), d.get("otelcol_pipeline"),
         d.get("enabled"), d.get("parent_device_id"), d.get("ha_role"), new_peer_id, device_id),
    )
    # Bidirectional HA peer link: keep the partner in sync
    if new_peer_id:
        await db.execute(
            "UPDATE devices SET ha_peer_id=? WHERE id=? AND (ha_peer_id IS NULL OR ha_peer_id=?)",
            (device_id, new_peer_id, device_id),
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
    # Update last_seen + status for every device that reported data this batch
    seen_device_ids = {v[0] for v in device_cache.values() if v[0] is not None}
    for did in seen_device_ids:
        await db.execute(
            "UPDATE devices SET last_seen=datetime('now'), status='up', updated_at=datetime('now') WHERE id=?",
            (did,),
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
# METRICS API (charts, Metrics page, alert engine)
# =============================================================================

def _parse_since(since: str | None) -> tuple[str | None, int]:
    """Parse a 'since' string into (iso_datetime, bucket_seconds).

    Accepts relative shortcuts ("1h", "6h", "24h", "7d") or an ISO datetime.
    Returns (since_iso, bucket_seconds) where bucket_seconds drives downsampling:
      1h  → raw (0)      6h → 5-min (300)
      24h → 15-min (900) 7d → 1-hour (3600)
      custom/long → auto-select based on span
    """
    from datetime import datetime, timezone, timedelta

    if not since:
        return None, 0

    _shortcuts = {
        "1h":  (timedelta(hours=1),  0),
        "6h":  (timedelta(hours=6),  300),
        "24h": (timedelta(hours=24), 900),
        "7d":  (timedelta(days=7),   3600),
    }
    if since in _shortcuts:
        delta, bucket = _shortcuts[since]
        iso = (datetime.now(tz=timezone.utc) - delta).isoformat()
        return iso, bucket

    # Treat as ISO datetime — auto-compute bucket from span
    try:
        dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        span_hours = (datetime.now(tz=timezone.utc) - dt).total_seconds() / 3600
        if span_hours <= 1.5:
            bucket = 0
        elif span_hours <= 8:
            bucket = 300
        elif span_hours <= 30:
            bucket = 900
        else:
            bucket = 3600
        return dt.isoformat(), bucket
    except Exception:
        return None, 0


@router.get("/devices/{device_id}/metrics/latest")
async def device_metrics_latest(
    device_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    """Latest value per OID for a registered device.
    Used by the Dashboard mini-panel and Metrics page header stats.
    """
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, ip FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    from app.storage.factory import get_storage
    return await get_storage().get_device_latest(device_id)


@router.get("/devices/{device_id}/metrics/history")
async def device_metrics_history(
    device_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    oid_labels: str | None = Query(None, description="Comma-separated OID labels; omit for all"),
    since: str | None = Query("1h", description="Relative: 1h|6h|24h|7d, or ISO datetime"),
    until: str | None = Query(None, description="ISO datetime upper bound (default: now)"),
    format: str | None = Query(None, description="'csv' to download as CSV"),
    limit: int = Query(2000, ge=1, le=10000),
    if_index: int | None = Query(None, description="Legacy: ignored (oid column is NULL)"),
    interface_label: str | None = Query(None, description="Filter to a specific interface (ifDescr value)"),
) -> Any:
    """Time-bucketed SNMP poll history for chart rendering.

    Response shape:
    {
      "series": [ { "bucket_ts", "oid_label", "avg_value", "max_value", "min_value", "sample_count" }, ... ],
      "alert_events": [ { "id", "fired_at", "severity", "message", "rule_name" }, ... ],
      "trap_events":  [ { "id", "received_at", "trap_oid", "source_ip" }, ... ],
      "bucket_seconds": 0 | 300 | 900 | 3600,
      "since_iso": "...",
    }
    """
    from fastapi.responses import StreamingResponse
    import csv as _csv, io as _io

    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, ip FROM devices WHERE id=?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")

    device_ip = dict(row)["ip"]
    since_iso, bucket_seconds = _parse_since(since)
    labels = [l.strip() for l in oid_labels.split(",")] if oid_labels else None

    from app.storage.factory import get_storage
    storage = get_storage()

    series = await storage.query_poll_history_bucketed(
        device_id=device_id,
        oid_labels=labels,
        since_iso=since_iso,
        until_iso=until,
        bucket_seconds=bucket_seconds,
        limit=limit,
        interface_label=interface_label,
    )

    # Companion: alert events in the same time window
    alert_events: list[dict] = []
    ae_conditions = ["ae.device_id = ?"]
    ae_params: list[Any] = [device_id]
    if since_iso:
        ae_conditions.append("ae.fired_at >= ?")
        ae_params.append(since_iso)
    if until:
        ae_conditions.append("ae.fired_at <= ?")
        ae_params.append(until)
    ae_where = "WHERE " + " AND ".join(ae_conditions)
    async with db.execute(
        f"""SELECT ae.id, ae.fired_at, ae.severity, ae.message, ae.resolved_at,
                   ae.auto_resolved, ar.name AS rule_name
            FROM alert_events ae
            JOIN alert_rules ar ON ar.id = ae.rule_id
            {ae_where}
            ORDER BY ae.fired_at ASC LIMIT 500""",
        ae_params,
    ) as cur:
        alert_events = [dict(r) for r in await cur.fetchall()]

    # Companion: trap events in the same time window
    trap_events = await storage.query_trap_events(
        device_id=device_id,
        since_iso=since_iso,
        until_iso=until,
        limit=200,
    )

    if format == "csv":
        buf = _io.StringIO()
        writer = _csv.writer(buf)
        writer.writerow(["bucket_ts", "oid_label", "avg_value", "max_value", "min_value", "sample_count"])
        for row in series:
            writer.writerow([row["bucket_ts"], row["oid_label"], row["avg_value"],
                             row["max_value"], row["min_value"], row["sample_count"]])
        buf.seek(0)
        return StreamingResponse(
            _io.BytesIO(buf.getvalue().encode("utf-8")),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="device-{device_id}-metrics.csv"'},
        )

    return {
        "series": series,
        "alert_events": alert_events,
        "trap_events": trap_events,
        "bucket_seconds": bucket_seconds,
        "since_iso": since_iso,
    }


@router.get("/devices/by-ip/{device_ip:path}/metrics/latest")
async def device_metrics_latest_by_ip(
    device_ip: str,
    _: CurrentUser,
) -> list[dict]:
    """Latest values for unregistered devices (dental path labels, etc.).
    Used when device_id is not known.
    """
    from app.storage.factory import get_storage
    return await get_storage().get_device_latest_by_ip(device_ip)


@router.get("/collectors/{collector_id}/ingest-rate")
async def collector_ingest_rate(
    collector_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    hours: int = Query(1, ge=1, le=24),
    bucket_minutes: int = Query(5, ge=1, le=60),
) -> list[dict]:
    """Polls-per-bucket sparkline for the Collectors page health view.

    Returns: [ { "bucket_ts", "poll_count", "active_devices" }, ... ]
    """
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id FROM collectors WHERE id=?", (collector_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Collector not found")
    from app.storage.factory import get_storage
    return await get_storage().get_ingest_rate(
        collector_id=collector_id, hours=hours, bucket_minutes=bucket_minutes
    )


@router.get("/metrics/overview")
async def metrics_overview(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    """All-device metrics overview for the dashboard cards view.

    Returns ALL registered devices regardless of whether they have SNMP data.
    No-data devices are included with has_data=false so missing data is visible.

    Response per item:
    {
      "device": { id, name, ip, device_type, status, org, groups, site, enabled, last_seen },
      "latest": { "<oid_label>": { value, value_numeric, value_type, polled_at }, ... },
      "has_data": true|false,
      "interface_count": N,
    }
    """
    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT id, name, ip, device_type, status, org, groups, site, enabled, last_seen
           FROM devices
           ORDER BY org ASC, name ASC"""
    ) as cur:
        device_rows = await cur.fetchall()

    devices = [dict(r) for r in device_rows]
    if not devices:
        return []

    device_ids = [d["id"] for d in devices]
    from app.storage.factory import get_storage
    storage = get_storage()

    # Single batch query for all devices' latest metrics
    batch = await storage.get_all_devices_latest(device_ids)

    result = []
    for dev in devices:
        did = dev["id"]
        latest_rows = batch.get(did, [])
        latest: dict[str, dict] = {
            row["oid_label"]: {
                "value":         row["value"],
                "value_numeric": row["value_numeric"],
                "value_type":    row["value_type"],
                "polled_at":     row["polled_at"],
            }
            for row in latest_rows
        }
        # Count distinct interfaces from the OID labels present in the latest snapshot.
        # Any OID whose label is an IF-MIB leaf implies at least one interface; the true
        # count comes from GET /devices/{id}/interfaces — this is just a quick estimate.
        if_labels = {k for k in latest if k in (
            "ifDescr", "ifAlias", "ifName",
            "ifOperStatus", "ifOperStatusMetric",
            "ifInOctets", "ifOutOctets",
        )}
        result.append({
            "device":          dev,
            "latest":          latest,
            "has_data":        len(latest_rows) > 0,
            "has_interfaces":  len(if_labels) > 0,
        })

    return result


@router.get("/devices/{device_id}/interfaces")
async def device_interfaces(
    device_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    """Interface list for a device.

    otelcol attaches ifDescr/ifName as metric attributes; the parser stores
    them in the interface_label column. Returns one entry per distinct interface.

    Each interface: { interface_label, name, oper_status, admin_status, speed_mbps, if_type, mac }
    """
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id FROM devices WHERE id=?", (device_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Device not found")
    from app.storage.factory import get_storage
    return await get_storage().get_device_interfaces(device_id)


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


# =============================================================================
# ORG / GROUP / SITE HIERARCHY MANAGEMENT
# =============================================================================

class OrgCreate(BaseModel):
    name: str


class GroupDefCreate(BaseModel):
    name: str
    org_id: int


class SiteDefCreate(BaseModel):
    name: str
    group_id: int


@router.get("/hierarchy")
async def get_hierarchy(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> list[dict]:
    """Return the full org → group → site hierarchy tree."""
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT id, name FROM orgs ORDER BY name") as cur:
        orgs = [dict(r) for r in await cur.fetchall()]
    for org in orgs:
        async with db.execute(
            "SELECT id, name FROM groups_def WHERE org_id=? ORDER BY name", (org["id"],)
        ) as cur:
            groups = [dict(r) for r in await cur.fetchall()]
        for grp in groups:
            async with db.execute(
                "SELECT id, name FROM sites_def WHERE group_id=? ORDER BY name", (grp["id"],)
            ) as cur:
                grp["sites"] = [dict(r) for r in await cur.fetchall()]
        org["groups"] = groups
    return orgs


@router.post("/hierarchy/orgs", status_code=201)
async def create_org(body: OrgCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    try:
        async with db.execute(
            "INSERT INTO orgs (name) VALUES (?) RETURNING id, name", (body.name.strip(),)
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail=f"Org '{body.name}' already exists")
        raise
    return {"id": row[0], "name": row[1], "groups": []}


@router.delete("/hierarchy/orgs/{org_id}", status_code=204)
async def delete_org(org_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute("SELECT id FROM orgs WHERE id=?", (org_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Org not found")
    await db.execute("DELETE FROM orgs WHERE id=?", (org_id,))
    await db.commit()


@router.post("/hierarchy/groups", status_code=201)
async def create_group_def(body: GroupDefCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    async with db.execute("SELECT id FROM orgs WHERE id=?", (body.org_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Org not found")
    try:
        async with db.execute(
            "INSERT INTO groups_def (org_id, name) VALUES (?,?) RETURNING id, name, org_id",
            (body.org_id, body.name.strip()),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail=f"Group '{body.name}' already exists in this org")
        raise
    return {"id": row[0], "name": row[1], "org_id": row[2], "sites": []}


@router.delete("/hierarchy/groups/{group_id}", status_code=204)
async def delete_group_def(group_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute("SELECT id FROM groups_def WHERE id=?", (group_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Group not found")
    await db.execute("DELETE FROM groups_def WHERE id=?", (group_id,))
    await db.commit()


@router.post("/hierarchy/sites", status_code=201)
async def create_site_def(body: SiteDefCreate, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> dict:
    async with db.execute("SELECT id FROM groups_def WHERE id=?", (body.group_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Group not found")
    try:
        async with db.execute(
            "INSERT INTO sites_def (group_id, name) VALUES (?,?) RETURNING id, name, group_id",
            (body.group_id, body.name.strip()),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(status_code=409, detail=f"Site '{body.name}' already exists in this group")
        raise
    return {"id": row[0], "name": row[1], "group_id": row[2]}


@router.delete("/hierarchy/sites/{site_id}", status_code=204)
async def delete_site_def(site_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute("SELECT id FROM sites_def WHERE id=?", (site_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Site not found")
    await db.execute("DELETE FROM sites_def WHERE id=?", (site_id,))
    await db.commit()


def _signal_reload() -> None:
    try:
        from app.main import app  # type: ignore[import]
        if hasattr(app.state, "local_collector"):
            app.state.local_collector.signal_reload()
    except Exception:
        pass
