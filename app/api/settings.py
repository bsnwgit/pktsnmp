"""
GET/PUT /api/settings — runtime application settings.
All settings are stored as JSON values in the SQLite settings table.
"""
from __future__ import annotations

import logging
import json
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

log = logging.getLogger("pktsnmp.settings")

router = APIRouter()

# ── Default settings (applied on first run) ───────────────────────────────────
DEFAULTS: dict[str, Any] = {
    # Storage
    "storage_backend": "sqlite",          # sqlite | duckdb | clickhouse — sqlite is the only
                                           # backend that implements the full StorageBase
                                           # interface (see app/storage/*.py); duckdb and
                                           # clickhouse are both missing several query methods
    "retention_days_raw": 90,
    "retention_days_hourly": 365,

    # SNMP
    "snmp_trap_enabled": False,           # Enable SNMP trap receiver
    "snmp_trap_port": 162,                # UDP port to listen for SNMP traps
    "snmp_poll_enabled": False,           # Enable SNMP polling engine
    "snmp_version": "v2c",               # v1 | v2c | v3
    "snmp_community": "public",          # SNMPv1/v2c community string
    "snmp_v3_username": "",              # SNMPv3 username
    "snmp_v3_auth_protocol": "SHA",      # MD5 | SHA
    "snmp_v3_auth_key": "",              # SNMPv3 auth passphrase
    "snmp_v3_priv_protocol": "AES",      # DES | AES
    "snmp_v3_priv_key": "",              # SNMPv3 priv passphrase

    # Auth
    "auth_local_enabled": True,
    "session_timeout_minutes": 480,

    # SAML 2.0
    "okta_saml_enabled": False,
    "okta_saml_idp_entity_id": "",       # From Okta metadata: IdP Entity ID
    "okta_saml_idp_sso_url": "",         # From Okta metadata: IdP SSO URL
    "okta_saml_idp_cert": "",            # From Okta metadata: X.509 cert (no header/footer)
    "okta_saml_sp_entity_id": "",        # Defaults to base_url/api/auth/saml/metadata
    "okta_saml_sp_cert": "",             # Optional: SP cert for signed requests
    "okta_saml_sp_key": "",              # Optional: SP private key for signed requests

    # Notifications
    "notify_email_enabled": False,
    "notify_email_smtp_host": "",
    "notify_email_smtp_port": 587,
    "notify_email_smtp_tls": True,
    "notify_email_username": "",
    "notify_email_password": "",
    "notify_email_from": "",
    "notify_email_default_to": [],

    "notify_slack_enabled": False,
    "notify_slack_webhook_url": "",
    "notify_slack_channel": "#alerts",

    "notify_pagerduty_enabled": False,
    "notify_pagerduty_integration_key": "",

    "notify_webhook_enabled": False,
    "notify_webhook_url": "",
    "notify_webhook_method": "POST",
    "notify_webhook_headers": {},
    "notify_webhook_payload_template": '{"alert": "{{ alert_name }}", "message": "{{ message }}"}',

    "notify_tracecat_enabled": False,
    "notify_tracecat_webhook_url": "",   # TraceCat workflow webhook URL
    "notify_tracecat_api_token": "",     # Bearer token for TraceCat API auth (optional)

    # ── App log forwarding (ship pktSNMP's own logs to pktLog) ────────────────
    # pktLog listens on 5514 by default and parses RFC 5424.
    "log_forward_enabled": False,
    "log_forward_host": "",
    "log_forward_port": 5514,
    "log_forward_protocol": "udp",       # udp | tcp
    "log_forward_level": "INFO",         # DEBUG | INFO | WARNING | ERROR
    "log_forward_app_name": "pktsnmp",

    # General
    "app_name": "pktSNMP",
    "base_url": "http://localhost:8767",
    "timezone": "UTC",

    # Set by pktHub on register/deregister (POST /api/suite/settings-lock) —
    # not user-editable. Frontend shows a "remotely managed" banner and
    # disables the local Settings UI when true.
    "hub_settings_managed": False,

    # Integrations
    "lucid_api_token": "",            # Lucidchart Personal Access Token for diagram export

    # SSL / TLS
    "ssl_enabled": False,             # Enable HTTPS
    "ssl_certfile": "",               # Absolute path to PEM cert file on server
    "ssl_keyfile": "",                # Absolute path to PEM private key on server

    # Alerts
    "alert_event_retention_days": 90, # Days to keep alert_events + notification_log rows

    "snmp_poll_default_interval_seconds": 60,  # Seconds between local poll cycles (read by poll_engine.py)
    "snmp_poll_max_concurrency": 10,           # Max concurrent SNMP polls in flight
    "snmp_trap_bind_address": "0.0.0.0",

    # Backup
    "backup_enabled": False,
    "backup_interval_hours": 24,
    "backup_rotation_count": 5,
    "backup_path": str(Path(get_settings().install_dir) / "backups"),
    "backup_include_clickhouse": True,

    # Resonance embed — the shared assistant surface every pkt* app mounts.
    # base_url must match the address enrolled on the resonance side exactly
    # (scheme, host, port; port blank behind a reverse proxy) because embed.js
    # derives its own origin from it. Enabled is deliberately separate from a
    # passing Test Connection: testing a key must never ship a widget to users.
    # Every connection field ships blank — an install has to be pointed at its
    # own resonance server before anything mounts.
    "resonance_enabled": False,
    "resonance_base_url": "",
    # Public origin of THIS app, as a browser sees it — the string that has to be
    # on the resonance key. Blank means "work it out from the request", which is
    # right for a direct install and wrong behind a reverse proxy: the app then
    # sees the internal scheme, host and port, not the address users type.
    "resonance_origin": "",
    # CA bundle for the server-to-server call to resonance. Blank uses httpx's
    # bundled certifi roots, which do NOT include anything an internal CA signed
    # — a certificate every browser trusts is still untrusted here. Point this at
    # the system store (/etc/ssl/certs/ca-certificates.crt on Debian/Ubuntu) when
    # resonance uses an internal CA.
    "resonance_ca_bundle": "",
    "resonance_key": "",              # <eid>.<secret> — encrypted at rest, masked in responses
    # What each local role may do with the assistant: "none" hides the launcher
    # entirely, anything above it lets that role open it. The stored shape keeps
    # "write" as a third level, matching the app that also publishes a data
    # surface for the assistant to act through, so adding one here later needs
    # no migration — but nothing in this app reads it yet, so the panel offers
    # only the two levels that do something.
    "resonance_role_levels": {"admin": "read", "analyst": "read", "viewer": "read"},
    "resonance_style": "bubble",      # bubble | inline
    "resonance_target": "",           # required when style is inline: id of an existing element
    "resonance_label": "",
    "resonance_side": "right",        # right | left
    "resonance_width": "",
    "resonance_height": "",
    "resonance_open": False,
    "resonance_exclude_paths": ["/login"],   # excluding a page discards any running conversation
}


# Sentinel mask written over secret values in GET responses.
# If the UI sends this value back on Save, treat it as "unchanged" and skip the write.
_MASK = "••••••••"
_SECRET_KEYS = frozenset({
    "notify_email_password",
    "notify_pagerduty_integration_key", "lucid_api_token",
    "okta_saml_sp_key", "notify_tracecat_api_token",
    "snmp_v3_auth_key", "snmp_v3_priv_key",
    "resonance_key",
})


# Credentials to another system, held the way the suite token and user API keys
# already are: Fernet at rest, not just masked on the way out. Masking alone
# protects the API response; it leaves the value readable to anything that can
# open the SQLite file.
_ENCRYPTED_KEYS = frozenset({
    "resonance_key",
})


def _store_value(key: str, value: Any) -> Any:
    """Encrypt on the way into the settings table, for keys that warrant it."""
    if key in _ENCRYPTED_KEYS and isinstance(value, str) and value:
        from app.crypto import encrypt_str
        return encrypt_str(value)
    return value


async def read_secret(db: aiosqlite.Connection, key: str) -> str:
    """Read and decrypt one _ENCRYPTED_KEYS setting for internal use.

    Returns "" when unset or undecryptable — a rotated credential key should
    read as "not configured" rather than raise on every request.
    """
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row or not row[0]:
        return ""
    try:
        stored = json.loads(row[0])
    except (json.JSONDecodeError, TypeError, ValueError):
        stored = row[0]
    if not isinstance(stored, str) or not stored:
        return ""
    from app.crypto import decrypt_str
    return decrypt_str(stored)


async def _ensure_defaults(db: aiosqlite.Connection) -> None:
    for key, value in DEFAULTS.items():
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )
    await db.commit()


def _safe_loads(raw: str):
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw  # tolerate a legacy/non-JSON-encoded value rather than 500ing the whole page


@router.get("/")
async def get_all_settings(_: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Return all settings as a flat dict. Sensitive values are masked."""
    await _ensure_defaults(db)
    async with db.execute("SELECT key, value FROM settings") as cur:
        rows = await cur.fetchall()

    result = {r[0]: _safe_loads(r[1]) for r in rows}

    # Mask secrets in API response
    for secret_key in _SECRET_KEYS:
        if result.get(secret_key):
            result[secret_key] = _MASK

    return result


@router.get("/{key}")
async def get_setting(key: str, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")
    value = _safe_loads(row[0])
    # Same masking the collection endpoint applies. Without it this route
    # hands any authenticated caller the stored value for a secret by name.
    if key in _SECRET_KEYS and value:
        value = _MASK
    return {key: value}


class SettingUpdate(BaseModel):
    value: Any


class TestNotificationRequest(BaseModel):
    channel: str


@router.put("/{key}")
async def update_setting(
    key: str,
    body: SettingUpdate,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    if key not in DEFAULTS:
        raise HTTPException(status_code=400, detail=f"Unknown setting key: {key}")

    # Never overwrite a secret with the display mask
    if key in _SECRET_KEYS and body.value == _MASK:
        return {"key": key, "updated": False, "skipped": "mask value"}

    value = body.value

    await db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, json.dumps(_store_value(key, value))),
    )
    await db.commit()

    return {"key": key, "updated": True}


@router.post("/bulk")
async def bulk_update(
    updates: dict[str, Any],
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Update multiple settings at once (Settings page Save button)."""
    unknown = [k for k in updates if k not in DEFAULTS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown keys: {unknown}")

    skipped = []
    for key, value in updates.items():
        # Never overwrite a secret with the display mask (user saved without changing it)
        if key in _SECRET_KEYS and value == _MASK:
            skipped.append(key)
            continue
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(_store_value(key, value))),
        )
    await db.commit()
    written = [k for k in updates if k not in skipped]
    return {"updated": written, "skipped": skipped}


@router.post("/test-notification")
async def test_notification(
    body: TestNotificationRequest,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Send a test notification on the specified channel using saved settings."""
    channel = body.channel
    valid = {"slack", "email", "pagerduty", "webhook", "tracecat"}
    if channel not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}. Valid: {sorted(valid)}")

    async def _get(key: str):
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        return json.loads(row[0]) if row else None

    TEST_RULE   = "pktSNMP Test"
    TEST_MSG    = "pktSNMP test notification — your configuration is working correctly."
    TEST_SEV    = "info"

    try:
        if channel == "slack":
            enabled = await _get("notify_slack_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Slack is not enabled"}
            url = await _get("notify_slack_webhook_url") or ""
            if not url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            import httpx
            payload = {"text": f":white_circle: *pktSNMP Test — {TEST_RULE}*\n{TEST_MSG}"}
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                return {"status": "sent", "detail": "Slack message delivered"}
            return {"status": "failed", "detail": f"Slack returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "email":
            enabled = await _get("notify_email_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Email is not enabled"}
            host      = await _get("notify_email_smtp_host")   or ""
            port      = await _get("notify_email_smtp_port")   or 587
            tls       = await _get("notify_email_smtp_tls")
            use_tls   = tls if tls is not None else True
            username  = await _get("notify_email_username")    or ""
            password  = await _get("notify_email_password")    or ""
            from_addr = await _get("notify_email_from")        or "pktsnmp@localhost"
            to_addrs  = await _get("notify_email_default_to")  or []
            if not host or not to_addrs:
                return {"status": "skipped", "detail": "SMTP host or recipient list not configured"}
            import aiosmtplib
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"[pktSNMP Test] {TEST_RULE}"
            msg["From"]    = from_addr
            msg["To"]      = ", ".join(to_addrs)
            msg.attach(MIMEText(f"pktSNMP Test Notification\n\n{TEST_MSG}", "plain"))
            await aiosmtplib.send(
                msg,
                hostname=host, port=int(port), use_tls=bool(use_tls),
                username=username or None, password=password or None,
            )
            return {"status": "sent", "detail": f"Email sent to {', '.join(to_addrs)}"}

        elif channel == "pagerduty":
            enabled = await _get("notify_pagerduty_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "PagerDuty is not enabled"}
            key = await _get("notify_pagerduty_integration_key") or ""
            if not key:
                return {"status": "skipped", "detail": "No integration key configured"}
            import httpx
            payload = {
                "routing_key": key,
                "event_action": "trigger",
                "payload": {
                    "summary": f"[pktSNMP Test] {TEST_RULE}: {TEST_MSG}",
                    "severity": "info",
                    "source": "pktsnmp",
                },
            }
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://events.pagerduty.com/v2/enqueue", json=payload, timeout=10
                )
            if resp.status_code in (200, 202):
                return {"status": "sent", "detail": "PagerDuty event triggered"}
            return {"status": "failed", "detail": f"PagerDuty returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "webhook":
            enabled = await _get("notify_webhook_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "Webhook is not enabled"}
            url      = await _get("notify_webhook_url")              or ""
            method   = await _get("notify_webhook_method")           or "POST"
            template = await _get("notify_webhook_payload_template") or ""
            headers  = await _get("notify_webhook_headers")          or {}
            if not url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            try:
                from jinja2 import Template
                from datetime import datetime, timezone
                rendered = Template(template).render(
                    alert_name=TEST_RULE, message=TEST_MSG,
                    severity=TEST_SEV, fired_at=datetime.now(tz=timezone.utc).isoformat(),
                )
                body_json = json.loads(rendered)
            except Exception as e:
                return {"status": "failed", "detail": f"Template render error: {e}"}
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method.upper(), url, json=body_json, headers=headers, timeout=10
                )
            if resp.status_code < 300:
                return {"status": "sent", "detail": f"Webhook returned HTTP {resp.status_code}"}
            return {"status": "failed", "detail": f"Webhook returned HTTP {resp.status_code}: {resp.text[:200]}"}

        elif channel == "tracecat":
            enabled = await _get("notify_tracecat_enabled")
            if not enabled:
                return {"status": "skipped", "detail": "TraceCat is not enabled"}
            webhook_url = await _get("notify_tracecat_webhook_url") or ""
            api_token   = await _get("notify_tracecat_api_token")   or ""
            if not webhook_url:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            from datetime import datetime, timezone
            payload = {
                "source": "pktsnmp",
                "event_id": 0,
                "alert_name": TEST_RULE,
                "severity": TEST_SEV,
                "message": TEST_MSG,
                "fired_at": datetime.now(tz=timezone.utc).isoformat(),
                "details": {"test": True},
            }
            headers: dict = {"Content-Type": "application/json"}
            if api_token:
                headers["Authorization"] = f"Bearer {api_token}"
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.post(webhook_url, json=payload, headers=headers, timeout=10)
            if resp.status_code < 300:
                return {"status": "sent", "detail": f"TraceCat webhook returned HTTP {resp.status_code}"}
            return {"status": "failed", "detail": f"TraceCat returned HTTP {resp.status_code}: {resp.text[:200]}"}

    except Exception:

        log.exception("provider test call failed")

        return {"status": "failed", "detail": "Request failed — see the app log for detail"}
