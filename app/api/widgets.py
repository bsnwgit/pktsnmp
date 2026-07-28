"""
pktSNMP — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{id}      → server-rendered HTML page (iframe target)
Options:  GET /api/widgets/options/* → JSON [{value,label}] for dynamic param pickers
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import get_settings
from app.storage.factory import get_storage

router = APIRouter()
_s     = get_settings()
_DB    = _s.db_path

# ── Manifest ──────────────────────────────────────────────────────────────────
MANIFEST = [
    {
        "id": "device_status", "title": "Device Status",
        "description": "All monitored devices with current up/down status",
        "view_path": "/api/widgets/device_status",
        "default_w": 640, "default_h": 380, "min_w": 320, "min_h": 200,
    },
    {
        "id": "interface_status", "title": "Interface Status",
        "description": "Per-interface operational status, admin status, and speed for one device",
        "view_path": "/api/widgets/interface_status",
        "default_w": 640, "default_h": 380, "min_w": 340, "min_h": 220,
        "params": [
            {
                "key": "device_id", "label": "Device", "type": "select",
                "options_path": "/api/widgets/options/devices",
            }
        ],
    },
    {
        "id": "active_alerts", "title": "Active Alerts",
        "description": "Recent unresolved SNMP alert events",
        "view_path": "/api/widgets/active_alerts",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },
]


@router.get("/manifest")
async def widget_manifest():
    return MANIFEST


# ── Shared page shell ───────────────────────────────────────────────────────────
def _page(title: str, body: str) -> str:
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0a1628;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
.hdr{{padding:8px 14px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:8px;flex-shrink:0;height:36px}}
.hdr-dot{{width:6px;height:6px;border-radius:50%;background:#2dd4bf;flex-shrink:0}}
.hdr-title{{font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.03em}}
.content{{flex:1;overflow:auto;padding:12px}}
table{{width:100%;border-collapse:collapse}}
th{{text-align:left;font-size:10px;color:#475569;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding:4px 8px;border-bottom:1px solid #1e293b}}
td{{padding:6px 8px;border-bottom:1px solid #0f172a;font-size:12px;color:#cbd5e1}}
tr:hover td{{background:#111827}}
.badge{{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}}
.bg{{background:#052e16;color:#4ade80}}.br{{background:#3f1515;color:#f87171}}
.by{{background:#422006;color:#fbbf24}}.bn{{background:#1e293b;color:#64748b}}
.empty{{text-align:center;padding:40px;color:#334155;font-size:12px}}
</style>
<script>setTimeout(()=>location.reload(),30000)</script>
</head><body>
<div class="hdr"><div class="hdr-dot"></div><div class="hdr-title">{title}</div></div>
<div class="content">{body}</div>
</body></html>"""


def _status_badge(status: str) -> str:
    s = (status or "").lower()
    if s == "up":
        return '<span class="badge bg">UP</span>'
    if s == "down":
        return '<span class="badge br">DOWN</span>'
    if s in ("degraded", "warning"):
        return '<span class="badge by">DEGRADED</span>'
    return f'<span class="badge bn">{(status or "UNKNOWN").upper()}</span>'


# ── Device Status widget ─────────────────────────────────────────────────────
@router.get("/device_status", response_class=HTMLResponse, include_in_schema=False)
async def widget_device_status():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name, ip, status, site FROM devices WHERE enabled=1 "
                "ORDER BY CASE status WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, name"
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception:
        pass

    if rows:
        trs = "".join(
            f"<tr><td>{r['name']}</td><td>{r['ip']}</td><td>{r.get('site') or ''}</td>"
            f"<td>{_status_badge(r['status'])}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Device</th><th>IP</th><th>Site</th><th>Status</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = '<div class="empty">No devices</div>'
    return HTMLResponse(_page("Device Status", body))


# ── Interface Status widget (per-device, dynamic) ────────────────────────────
@router.get("/interface_status", response_class=HTMLResponse, include_in_schema=False)
async def widget_interface_status(device_id: int | None = None):
    if not device_id:
        return HTMLResponse(_page("Interface Status", '<div class="empty">Select a device</div>'))

    device_name = str(device_id)
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT name FROM devices WHERE id=?", (device_id,)) as cur:
                row = await cur.fetchone()
                if row:
                    device_name = row["name"]
    except Exception:
        pass

    ifaces = []
    try:
        ifaces = await get_storage().get_device_interfaces(device_id)
    except Exception:
        ifaces = []

    if ifaces:
        trs = "".join(
            f"<tr><td>{i['name']}</td>"
            f"<td>{_status_badge(i.get('oper_status'))}</td>"
            f"<td>{_status_badge(i.get('admin_status'))}</td>"
            f"<td>{(str(round(i['speed_mbps'])) + ' Mbps') if i.get('speed_mbps') else '—'}</td></tr>"
            for i in ifaces
        )
        body = (
            f'<div style="margin-bottom:8px;color:#64748b;font-size:11px">{device_name}</div>'
            "<table><thead><tr><th>Interface</th><th>Oper</th><th>Admin</th><th>Speed</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = f'<div class="empty">No interface data for {device_name}</div>'
    return HTMLResponse(_page("Interface Status", body))


# ── Active Alerts widget ──────────────────────────────────────────────────────
@router.get("/active_alerts", response_class=HTMLResponse, include_in_schema=False)
async def widget_active_alerts():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT ae.severity, ae.message, ae.fired_at, d.name as device_name
                   FROM alert_events ae LEFT JOIN devices d ON d.id = ae.device_id
                   WHERE ae.resolved_at IS NULL AND ae.acked_at IS NULL
                   ORDER BY ae.fired_at DESC LIMIT 40"""
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception:
        pass

    if rows:
        trs = "".join(
            f"<tr><td>{_status_badge('down' if r['severity'] in ('critical','high') else 'degraded')}</td>"
            f"<td>{r.get('device_name') or ''}</td><td>{r['message']}</td>"
            f"<td>{str(r['fired_at'])[:19].replace('T',' ')}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Severity</th><th>Device</th><th>Message</th><th>Fired</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = '<div class="empty">No active alerts</div>'
    return HTMLResponse(_page("Active Alerts", body))


# ── Param option pickers ──────────────────────────────────────────────────────
@router.get("/options/devices")
async def widget_options_devices():
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name, ip FROM devices WHERE enabled=1 ORDER BY name"
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
        return JSONResponse([{"value": str(r["id"]), "label": f"{r['name']} ({r['ip']})"} for r in rows])
    except Exception:
        return JSONResponse([])
