"""
pktSNMP — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{id}      → server-rendered HTML page (iframe target)
Options:  GET /api/widgets/options/* → JSON [{value,label}] for dynamic param pickers
"""
from __future__ import annotations

import html
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import get_settings
from app.dependencies import require_suite_token
from app.storage.factory import get_storage

# These views are embedded as unauthenticated iframes by pktHub's NOC Builder,
# so they can't require a login session — but they do render internal device,
# metric and alert data, so every route on this router requires a valid
# X-Suite-Token (the trusted-proxy secret pktHub already sends on every
# proxied request).
# ── Refresh interval ──────────────────────────────────────────────────────────
# pktHub's Settings → NOC → "Widget refresh" governs how often a tile reloads
# itself. It arrives as ?refresh=<seconds> on the widget URL; captured here as a
# router dependency so the ~150 view functions need no signature change.
_REFRESH: ContextVar = ContextVar("widget_refresh", default=30)


async def _capture_refresh(request: Request) -> None:
    raw = request.query_params.get("refresh")
    try:
        _REFRESH.set(max(5, min(int(raw), 3600)) if raw else 30)
    except (TypeError, ValueError):
        _REFRESH.set(30)


router = APIRouter(dependencies=[Depends(_capture_refresh), Depends(require_suite_token)])
_s     = get_settings()
_DB    = _s.db_path

# ── Manifest ──────────────────────────────────────────────────────────────────
# `category` groups these in pktHub's NOC library picker. Every data surface the
# app renders in its own UI should have an entry here — the NOC builder can only
# offer what this list declares.
_DEVICE_PARAM = {
    "key": "device_id", "label": "Device", "type": "select",
    "options_path": "/api/widgets/options/devices",
}

MANIFEST = [
    # ── Overview ──────────────────────────────────────────────────────────────
    {
        "id": "device_summary", "title": "Device Summary", "category": "Overview",
        "description": "Total, up, down and degraded device counts across the estate",
        "view_path": "/api/widgets/device_summary",
        "default_w": 520, "default_h": 200, "min_w": 300, "min_h": 150,
    },
    {
        "id": "alert_summary", "title": "Alert Summary", "category": "Overview",
        "description": "Active alert counts by severity",
        "view_path": "/api/widgets/alert_summary",
        "default_w": 420, "default_h": 200, "min_w": 260, "min_h": 150,
    },
    {
        "id": "devices_by_site", "title": "Devices by Site", "category": "Overview",
        "description": "Device count and health per site",
        "view_path": "/api/widgets/devices_by_site",
        "default_w": 480, "default_h": 320, "min_w": 280, "min_h": 200,
    },

    # ── Devices ───────────────────────────────────────────────────────────────
    {
        "id": "device_status", "title": "Device Status", "category": "Devices",
        "description": "All monitored devices with current up/down status",
        "view_path": "/api/widgets/device_status",
        "default_w": 640, "default_h": 380, "min_w": 320, "min_h": 200,
    },
    {
        "id": "metrics_overview", "title": "Metrics Overview", "category": "Devices",
        "description": "Latest polled metric values for every device",
        "view_path": "/api/widgets/metrics_overview",
        "default_w": 760, "default_h": 420, "min_w": 380, "min_h": 240,
    },
    {
        "id": "device_uptime", "title": "Device Uptime", "category": "Devices",
        "description": "Reported uptime per device, least stable first",
        "view_path": "/api/widgets/device_uptime",
        "default_w": 560, "default_h": 360, "min_w": 300, "min_h": 200,
    },

    # ── Metrics (charts) ──────────────────────────────────────────────────────
    {
        "id": "metric_trend", "title": "Metric Trend", "category": "Metrics",
        "description": "Time-series chart of any polled OID for one device",
        "view_path": "/api/widgets/metric_trend",
        "default_w": 680, "default_h": 320, "min_w": 320, "min_h": 180,
        "params": [
            _DEVICE_PARAM,
            # {device_id} is substituted from the widget's own config by pktHub,
            # so the metric list narrows to what that device actually reports —
            # including OIDs first polled long after this manifest was written.
            {"key": "oid_label", "label": "Metric", "type": "select",
             "options_path": "/api/widgets/options/oid_labels?device_id={device_id}"},
            {"key": "hours", "label": "Window", "type": "select",
             "options": [{"value": "1", "label": "1 hour"}, {"value": "6", "label": "6 hours"},
                         {"value": "24", "label": "24 hours"}, {"value": "168", "label": "7 days"}]},
        ],
    },
    {
        "id": "interface_throughput", "title": "Interface Throughput", "category": "Metrics",
        "description": "In/out throughput chart for one interface",
        "view_path": "/api/widgets/interface_throughput",
        "default_w": 680, "default_h": 320, "min_w": 320, "min_h": 180,
        "params": [
            _DEVICE_PARAM,
            {"key": "interface_label", "label": "Interface", "type": "select",
             "options_path": "/api/widgets/options/interfaces?device_id={device_id}"},
            {"key": "hours", "label": "Window", "type": "select",
             "options": [{"value": "1", "label": "1 hour"}, {"value": "6", "label": "6 hours"},
                         {"value": "24", "label": "24 hours"}, {"value": "168", "label": "7 days"}]},
        ],
    },
    {
        "id": "ingest_rate", "title": "Poll Ingest Rate", "category": "Metrics",
        "description": "Polls per minute over time",
        "view_path": "/api/widgets/ingest_rate",
        "default_w": 560, "default_h": 280, "min_w": 280, "min_h": 160,
    },

    # ── Interfaces ────────────────────────────────────────────────────────────
    {
        "id": "interface_status", "title": "Interface Status", "category": "Interfaces",
        "description": "Per-interface operational status, admin status, and speed for one device",
        "view_path": "/api/widgets/interface_status",
        "default_w": 640, "default_h": 380, "min_w": 340, "min_h": 220,
        "params": [_DEVICE_PARAM],
    },
    {
        "id": "interfaces_down", "title": "Interfaces Down", "category": "Interfaces",
        "description": "Interfaces admin-up but operationally down, across all devices",
        "view_path": "/api/widgets/interfaces_down",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },

    # ── Alerts ────────────────────────────────────────────────────────────────
    {
        "id": "active_alerts", "title": "Active Alerts", "category": "Alerts",
        "description": "Recent unresolved SNMP alert events",
        "view_path": "/api/widgets/active_alerts",
        "default_w": 640, "default_h": 360, "min_w": 320, "min_h": 200,
    },
    {
        "id": "recent_traps", "title": "Recent Traps", "category": "Alerts",
        "description": "Latest received SNMP traps",
        "view_path": "/api/widgets/recent_traps",
        "default_w": 700, "default_h": 360, "min_w": 340, "min_h": 200,
    },

    # ── Collectors ────────────────────────────────────────────────────────────
    {
        "id": "collector_status", "title": "Collector Status", "category": "Collectors",
        "description": "Poller health and time since last successful poll",
        "view_path": "/api/widgets/collector_status",
        "default_w": 560, "default_h": 320, "min_w": 300, "min_h": 180,
    },
]


@router.get("/manifest")
async def widget_manifest():
    return MANIFEST



# ── Widget states ──────────────────────────────────────────────────────────────
# A blank tile on a wallboard reads as "all quiet", so the three reasons a widget
# can show nothing must look different from each other:
#   empty — the query ran and there genuinely is nothing
#   cfg   — the widget needs a param chosen in the NOC editor before it can run
#   err   — the query failed; this must never be mistaken for "nothing to report"
# Query helpers record failures here rather than swallowing them; _page() renders
# the error state instead of whatever half-built body the caller produced. The
# ContextVar is per-request: each request runs in its own task context.
_WIDGET_ERR: ContextVar = ContextVar("widget_err", default=None)


def _note_err(exc: BaseException) -> None:
    _WIDGET_ERR.set(f"{type(exc).__name__}: {exc}"[:200])


def _state(kind: str, msg: str, sub: str = "") -> str:
    icon = {"empty": "○", "cfg": "⚙", "err": "⚠"}.get(kind, "○")
    sub_html = f'<div class="state-sub">{html.escape(str(sub))}</div>' if sub else ""
    return (f'<div class="state state-{kind}"><div class="state-icon">{icon}</div>'
            f'<div class="state-msg">{html.escape(str(msg))}</div>{sub_html}</div>')


def _empty(msg: str) -> str:
    return _state("empty", msg)


def _needs(msg: str) -> str:
    """The widget is fine — it is waiting on a filter the NOC editor must set."""
    return _state("cfg", msg, "Select it in the widget's Filters panel")


# ── Shared page shell ───────────────────────────────────────────────────────────
def _page(title: str, body: str) -> str:
    # Widget titles carry device/metric/subnet names chosen in the NOC editor
    # and read back from device data, and these pages render on an
    # unauthenticated display URL — escape before interpolating.
    title = html.escape(str(title))
    # A failed query leaves a body saying "nothing here" — which is a lie.
    _err = _WIDGET_ERR.get()
    if _err:
        body = _state("err", "Widget unavailable", _err)
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#04060a;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
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
.tile-row{{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}}
.tile{{flex:1;min-width:84px;background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px 12px}}
.tile-label{{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px}}
.tile-value{{font-size:22px;font-weight:700;color:#e2e8f0}}
.bar-row{{display:flex;align-items:center;gap:8px;margin-bottom:8px}}
.bar-lbl{{font-size:11px;color:#94a3b8;width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.bar-trk{{flex:1;background:#1e293b;border-radius:3px;height:8px;overflow:hidden}}
.bar-fill{{height:8px;border-radius:3px;background:#2dd4bf}}
.bar-val{{font-size:10px;color:#475569;width:62px;text-align:right;flex-shrink:0}}
.chart-wrap{{width:100%;height:100%;min-height:90px;display:flex;flex-direction:column}}
.chart-meta{{display:flex;gap:12px;font-size:10px;color:#475569;margin-bottom:6px;flex-wrap:wrap}}
.chart-meta b{{color:#94a3b8;font-weight:600}}
.chart-svg{{flex:1;width:100%;min-height:0}}
.legend{{display:flex;gap:12px;font-size:10px;color:#94a3b8;margin-top:6px;flex-wrap:wrap}}
.legend i{{width:8px;height:2px;display:inline-block;margin-right:4px;vertical-align:middle}}
.state{{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:80px;text-align:center;padding:18px;gap:5px}}
.state-icon{{font-size:17px;line-height:1;opacity:0.85}}
.state-msg{{font-size:12px;font-weight:500}}
.state-sub{{font-size:10px;color:#64748b;max-width:92%;word-break:break-word}}
.state-empty{{color:#64748b}}
.state-cfg{{color:#fbbf24}}
.state-err{{color:#f87171}}
</style>
<script>setTimeout(()=>location.reload(),{_REFRESH.get() * 1000})</script>
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
    return f'<span class="badge bn">{html.escape((status or "UNKNOWN").upper())}</span>'


# ── Time window ─────────────────────────────────────────────────────────────────
def _since(hours: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")


# ── Device lookup ───────────────────────────────────────────────────────────────
async def _device_name(device_id: int) -> str | None:
    """None when the device is gone. A NOC screen outlives the inventory it was
    built against, so a widget pinned to a decommissioned device has to say so
    rather than render an empty frame the wall-watcher reads as 'all quiet'."""
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT name FROM devices WHERE id=?", (device_id,)) as cur:
                row = await cur.fetchone()
        return row["name"] if row else None
    except Exception:
        return None


def _gone(what: str) -> str:
    return f_empty('{html.escape(what)} no longer exists')


# ── Formatting ──────────────────────────────────────────────────────────────────
def _fmt_n(n) -> str:
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return "—"
    for div, suf in ((1_000_000_000, "G"), (1_000_000, "M"), (1_000, "K")):
        if abs(n) >= div:
            return f"{n / div:.1f}{suf}"
    return f"{n:.0f}" if n == int(n) else f"{n:.2f}"


def _fmt_bps(n) -> str:
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return "—"
    for div, suf in ((1e9, "Gbps"), (1e6, "Mbps"), (1e3, "Kbps")):
        if abs(n) >= div:
            return f"{n / div:.2f} {suf}"
    return f"{n:.0f} bps"


def _fmt_ts(ts) -> str:
    return str(ts)[:19].replace("T", " ") if ts else "—"


def _fmt_uptime(ticks) -> str:
    """SNMP sysUpTime is in hundredths of a second."""
    try:
        secs = int(float(ticks or 0) / 100)
    except (TypeError, ValueError):
        return "—"
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    return f"{d}d {h}h" if d else f"{h}h {rem // 60}m"


# ── Tiles / bars ────────────────────────────────────────────────────────────────
def _tiles(pairs) -> str:
    return '<div class="tile-row">' + "".join(
        f'<div class="tile"><div class="tile-label">{html.escape(str(label))}</div>'
        f'<div class="tile-value">{html.escape(str(value))}</div></div>'
        for label, value in pairs
    ) + "</div>"


def _bars(rows, color: str = "#2dd4bf") -> str:
    """rows = [(label, numeric_value, display_value)] — scaled to the largest."""
    peak = max((r[1] or 0) for r in rows) if rows else 0
    return "".join(
        f'<div class="bar-row"><div class="bar-lbl" title="{html.escape(str(lbl))}">{html.escape(str(lbl))}</div>'
        f'<div class="bar-trk"><div class="bar-fill" style="width:{(val / peak * 100) if peak else 0:.1f}%;background:{color}"></div></div>'
        f'<div class="bar-val">{html.escape(str(disp))}</div></div>'
        for lbl, val, disp in rows
    )


# ── Inline SVG line chart ───────────────────────────────────────────────────────
# Server-rendered so the iframe stays dependency-free — pktSNMP ships no charting
# library to these views, and the NOC display must render without network access
# to anything but this app.
_SERIES_COLORS = ("#2dd4bf", "#60a5fa", "#fbbf24", "#f87171", "#a78bfa")


def _line_chart(series, fmt=_fmt_n, height: int = 120) -> str:
    """series = [(label, [float, ...])] — equal-length samples, oldest first.

    Renders a fixed viewBox stretched to the widget's width, so the same markup
    works at any size the NOC canvas gives it."""
    series = [(lbl, [v for v in vals if v is not None]) for lbl, vals in series]
    series = [(lbl, vals) for lbl, vals in series if len(vals) >= 2]
    if not series:
        return _empty('No samples in window')

    W, H, PAD = 600, height, 4
    lo = min(min(v) for _, v in series)
    hi = max(max(v) for _, v in series)
    span = (hi - lo) or 1.0

    def _y(v: float) -> float:
        return PAD + (H - 2 * PAD) * (1 - (v - lo) / span)

    paths, legend = [], []
    for i, (lbl, vals) in enumerate(series):
        color = _SERIES_COLORS[i % len(_SERIES_COLORS)]
        step  = W / (len(vals) - 1)
        pts   = [(j * step, _y(v)) for j, v in enumerate(vals)]
        line  = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        area  = f"{line} L{W:.1f},{H} L0,{H} Z"
        paths.append(
            f'<path d="{area}" fill="{color}" opacity="0.10"/>'
            f'<path d="{line}" fill="none" stroke="{color}" stroke-width="1.5" '
            f'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
        )
        legend.append(
            f'<span><i style="background:{color}"></i>{html.escape(str(lbl))} '
            f'<b>{html.escape(fmt(vals[-1]))}</b></span>'
        )

    meta = (f'<div class="chart-meta"><span>min <b>{html.escape(fmt(lo))}</b></span>'
            f'<span>max <b>{html.escape(fmt(hi))}</b></span>'
            f'<span>samples <b>{max(len(v) for _, v in series)}</b></span></div>')
    return (
        f'<div class="chart-wrap">{meta}'
        f'<svg class="chart-svg" viewBox="0 0 {W} {H}" preserveAspectRatio="none" '
        f'xmlns="http://www.w3.org/2000/svg">{"".join(paths)}</svg>'
        f'<div class="legend">{"".join(legend)}</div></div>'
    )


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
    except Exception as exc:
        _note_err(exc)

    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['name']))}</td><td>{html.escape(str(r['ip']))}</td>"
            f"<td>{html.escape(str(r.get('site') or ''))}</td>"
            f"<td>{_status_badge(r['status'])}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Device</th><th>IP</th><th>Site</th><th>Status</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = _empty('No devices are enabled for polling')
    return HTMLResponse(_page("Device Status", body))


# ── Interface Status widget (per-device, dynamic) ────────────────────────────
@router.get("/interface_status", response_class=HTMLResponse, include_in_schema=False)
async def widget_interface_status(device_id: int | None = None):
    if not device_id:
        return HTMLResponse(_page("Interface Status", _needs('Select a device')))

    device_name = await _device_name(device_id)
    if device_name is None:
        return HTMLResponse(_page("Interface Status", _gone(f"Device {device_id}")))

    ifaces = []
    try:
        ifaces = await get_storage().get_device_interfaces(device_id)
    except Exception as exc:
        _note_err(exc)
        ifaces = []

    if ifaces:
        trs = "".join(
            f"<tr><td>{html.escape(str(i['name']))}</td>"
            f"<td>{_status_badge(i.get('oper_status'))}</td>"
            f"<td>{_status_badge(i.get('admin_status'))}</td>"
            f"<td>{(str(round(i['speed_mbps'])) + ' Mbps') if i.get('speed_mbps') else '—'}</td></tr>"
            for i in ifaces
        )
        body = (
            f'<div style="margin-bottom:8px;color:#64748b;font-size:11px">{html.escape(str(device_name))}</div>'
            "<table><thead><tr><th>Interface</th><th>Oper</th><th>Admin</th><th>Speed</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = f_empty('No interface data for {html.escape(str(device_name))}')
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
    except Exception as exc:
        _note_err(exc)

    if rows:
        trs = "".join(
            f"<tr><td>{_status_badge('down' if r['severity'] in ('critical','high') else 'degraded')}</td>"
            f"<td>{html.escape(str(r.get('device_name') or ''))}</td>"
            f"<td>{html.escape(str(r['message']))}</td>"
            f"<td>{html.escape(str(r['fired_at'])[:19].replace('T',' '))}</td></tr>"
            for r in rows
        )
        body = (
            "<table><thead><tr><th>Severity</th><th>Device</th><th>Message</th><th>Fired</th></tr></thead>"
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        body = _empty('No active alerts')
    return HTMLResponse(_page("Active Alerts", body))


# ── Device Summary widget ─────────────────────────────────────────────────────
@router.get("/device_summary", response_class=HTMLResponse, include_in_schema=False)
async def widget_device_summary():
    counts, total, disabled = {}, 0, 0
    try:
        async with aiosqlite.connect(_DB) as db:
            async with db.execute(
                "SELECT COALESCE(status,'unknown'), COUNT(*) FROM devices WHERE enabled=1 GROUP BY 1"
            ) as cur:
                counts = {str(s).lower(): n for s, n in await cur.fetchall()}
            async with db.execute("SELECT COUNT(*) FROM devices WHERE enabled=0") as cur:
                disabled = (await cur.fetchone())[0]
    except Exception as exc:
        _note_err(exc)

    total = sum(counts.values())
    body = _tiles([
        ("Devices",  total),
        ("Up",       counts.get("up", 0)),
        ("Down",     counts.get("down", 0)),
        ("Degraded", counts.get("degraded", 0)),
        ("Disabled", disabled),
    ])
    return HTMLResponse(_page("Device Summary", body))


# ── Alert Summary widget ──────────────────────────────────────────────────────
@router.get("/alert_summary", response_class=HTMLResponse, include_in_schema=False)
async def widget_alert_summary():
    counts = {}
    try:
        async with aiosqlite.connect(_DB) as db:
            async with db.execute(
                """SELECT LOWER(severity), COUNT(*) FROM alert_events
                   WHERE resolved_at IS NULL AND acked_at IS NULL GROUP BY 1"""
            ) as cur:
                counts = {str(s): n for s, n in await cur.fetchall()}
    except Exception as exc:
        _note_err(exc)

    body = _tiles([
        ("Active",   sum(counts.values())),
        ("Critical", counts.get("critical", 0)),
        ("Warning",  counts.get("warning", 0)),
        ("Info",     counts.get("info", 0)),
    ])
    return HTMLResponse(_page("Alert Summary", body))


# ── Devices by Site widget ────────────────────────────────────────────────────
@router.get("/devices_by_site", response_class=HTMLResponse, include_in_schema=False)
async def widget_devices_by_site():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT CASE WHEN site = '' THEN 'Unassigned' ELSE site END AS site,
                          COUNT(*) AS total,
                          SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down
                   FROM devices WHERE enabled=1 GROUP BY site ORDER BY total DESC LIMIT 20"""
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    if rows:
        body = _bars([
            (r["site"], r["total"],
             f"{r['total']}" + (f" · {r['down']}↓" if r["down"] else ""))
            for r in rows
        ])
    else:
        body = _empty('No devices are enabled for polling')
    return HTMLResponse(_page("Devices by Site", body))


# ── Metrics Overview widget ───────────────────────────────────────────────────
@router.get("/metrics_overview", response_class=HTMLResponse, include_in_schema=False)
async def widget_metrics_overview():
    devices = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name, ip, status, site FROM devices WHERE enabled=1 ORDER BY name LIMIT 60"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    latest = {}
    if devices:
        try:
            latest = await get_storage().get_all_devices_latest([d["id"] for d in devices])
        except Exception as exc:
            _note_err(exc)
            latest = {}

    if devices:
        trs = []
        for d in devices:
            metrics = {r.get("oid_label"): r for r in latest.get(d["id"], []) if r.get("oid_label")}
            polled  = next((m.get("polled_at") for m in metrics.values() if m.get("polled_at")), None)
            trs.append(
                f"<tr><td>{html.escape(str(d['name']))}</td>"
                f"<td>{_status_badge(d['status'])}</td>"
                f"<td>{len(metrics)}</td>"
                f"<td>{html.escape(_fmt_ts(polled))}</td></tr>"
            )
        body = ("<table><thead><tr><th>Device</th><th>Status</th><th>Metrics</th><th>Last Poll</th></tr></thead>"
                f"<tbody>{''.join(trs)}</tbody></table>")
    else:
        body = _empty('No devices are enabled for polling')
    return HTMLResponse(_page("Metrics Overview", body))


# ── Device Uptime widget ──────────────────────────────────────────────────────
@router.get("/device_uptime", response_class=HTMLResponse, include_in_schema=False)
async def widget_device_uptime():
    devices = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name FROM devices WHERE enabled=1 ORDER BY name LIMIT 60"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    latest = {}
    if devices:
        try:
            latest = await get_storage().get_all_devices_latest([d["id"] for d in devices])
        except Exception as exc:
            _note_err(exc)
            latest = {}

    # sysUpTime is published under whatever label the OID catalog gives it, so
    # match on name rather than assuming one spelling.
    rows = []
    for d in devices:
        ticks = None
        for r in latest.get(d["id"], []):
            if "uptime" in str(r.get("oid_label") or "").lower():
                ticks = r.get("value_numeric")
                break
        if ticks is not None:
            rows.append((d["name"], float(ticks), _fmt_uptime(ticks)))

    if rows:
        rows.sort(key=lambda r: r[1])       # least stable first
        body = _bars(rows, color="#60a5fa")
    else:
        body = _empty('No device is reporting a sysUpTime OID')
    return HTMLResponse(_page("Device Uptime", body))


# ── Metric Trend widget (chart) ───────────────────────────────────────────────
@router.get("/metric_trend", response_class=HTMLResponse, include_in_schema=False)
async def widget_metric_trend(
    device_id: int | None = None, oid_label: str | None = None, hours: int = 6
):
    if not device_id or not oid_label:
        return HTMLResponse(_page("Metric Trend", _needs('Select a device and metric')))
    if await _device_name(device_id) is None:
        return HTMLResponse(_page("Metric Trend", _gone(f"Device {device_id}")))

    hours  = max(1, min(int(hours or 6), 720))
    bucket = 60 if hours <= 1 else (300 if hours <= 6 else (900 if hours <= 24 else 3600))
    rows   = []
    try:
        rows = await get_storage().query_poll_history_bucketed(
            device_id=device_id, oid_labels=[oid_label],
            since_iso=_since(hours), bucket_seconds=bucket, limit=2000,
        )
    except Exception as exc:
        _note_err(exc)
        rows = []

    vals = [r.get("avg_value") for r in rows if r.get("avg_value") is not None]
    body = _line_chart([(oid_label, vals)])
    return HTMLResponse(_page(f"{oid_label} — last {hours}h", body))


# ── Interface Throughput widget (chart) ───────────────────────────────────────
@router.get("/interface_throughput", response_class=HTMLResponse, include_in_schema=False)
async def widget_interface_throughput(
    device_id: int | None = None, interface_label: str | None = None, hours: int = 6
):
    if not device_id or not interface_label:
        return HTMLResponse(_page("Interface Throughput",
                                  _needs('Select a device and interface')))
    if await _device_name(device_id) is None:
        return HTMLResponse(_page("Interface Throughput", _gone(f"Device {device_id}")))

    hours  = max(1, min(int(hours or 6), 720))
    bucket = 60 if hours <= 1 else (300 if hours <= 6 else (900 if hours <= 24 else 3600))
    rows   = []
    try:
        rows = await get_storage().query_poll_history_bucketed(
            device_id=device_id, interface_label=interface_label,
            since_iso=_since(hours), bucket_seconds=bucket, limit=2000,
        )
    except Exception as exc:
        _note_err(exc)
        rows = []

    # Counter labels vary by device MIB (ifInOctets vs ifHCInOctets), so pick the
    # in/out pair by direction keyword rather than assuming one spelling.
    buckets: dict[str, list] = {}
    for r in rows:
        lbl = str(r.get("oid_label") or "")
        if r.get("avg_value") is not None and ("in" in lbl.lower() or "out" in lbl.lower()):
            buckets.setdefault(lbl, []).append(r["avg_value"])

    series = sorted(buckets.items(), key=lambda kv: ("out" in kv[0].lower(), kv[0]))
    body   = _line_chart(series, fmt=_fmt_bps) if series else _empty('No throughput samples')
    return HTMLResponse(_page(f"{interface_label} — last {hours}h", body))


# ── Poll Ingest Rate widget (chart) ───────────────────────────────────────────
@router.get("/ingest_rate", response_class=HTMLResponse, include_in_schema=False)
async def widget_ingest_rate(hours: int = 6):
    hours = max(1, min(int(hours or 6), 24))
    rows  = []
    try:
        rows = await get_storage().get_ingest_rate(hours=hours, bucket_minutes=5)
    except Exception as exc:
        _note_err(exc)
        rows = []

    polls   = [r.get("poll_count") for r in rows if r.get("poll_count") is not None]
    devices = [r.get("active_devices") for r in rows if r.get("active_devices") is not None]
    body    = _line_chart([("Polls", polls), ("Devices", devices)])
    return HTMLResponse(_page(f"Poll Ingest Rate — last {hours}h", body))


# ── Interfaces Down widget ────────────────────────────────────────────────────
@router.get("/interfaces_down", response_class=HTMLResponse, include_in_schema=False)
async def widget_interfaces_down():
    devices = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name FROM devices WHERE enabled=1 ORDER BY name LIMIT 60"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    storage, down = get_storage(), []
    for d in devices:
        try:
            ifaces = await storage.get_device_interfaces(d["id"])
        except Exception:
            continue
        for i in ifaces:
            # Admin-up but oper-down is the actionable case; admin-down is intentional.
            if str(i.get("oper_status") or "").lower() == "down" \
               and str(i.get("admin_status") or "").lower() != "down":
                down.append((d["name"], i))

    if down:
        trs = "".join(
            f"<tr><td>{html.escape(str(dev))}</td><td>{html.escape(str(i.get('name') or ''))}</td>"
            f"<td>{_status_badge(i.get('oper_status'))}</td>"
            f"<td>{(str(round(i['speed_mbps'])) + ' Mbps') if i.get('speed_mbps') else '—'}</td></tr>"
            for dev, i in down[:60]
        )
        body = ("<table><thead><tr><th>Device</th><th>Interface</th><th>Oper</th><th>Speed</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('Every admin-up interface is operationally up')
    return HTMLResponse(_page("Interfaces Down", body))


# ── Recent Traps widget ───────────────────────────────────────────────────────
@router.get("/recent_traps", response_class=HTMLResponse, include_in_schema=False)
async def widget_recent_traps():
    rows = []
    try:
        rows = await get_storage().query_trap_events(limit=40)
    except Exception as exc:
        _note_err(exc)
        rows = []

    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(_fmt_ts(r.get('received_at')))}</td>"
            f"<td>{html.escape(str(r.get('source_ip') or ''))}</td>"
            f"<td>{html.escape(str(r.get('trap_oid') or ''))}</td>"
            f"<td>{html.escape(str(r.get('snmp_version') or ''))}</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Received</th><th>Source</th><th>Trap OID</th><th>Ver</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No SNMP traps received yet')
    return HTMLResponse(_page("Recent Traps", body))


# ── Collector Status widget ───────────────────────────────────────────────────
@router.get("/collector_status", response_class=HTMLResponse, include_in_schema=False)
async def widget_collector_status():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name, ip, status, last_seen, version FROM collectors ORDER BY name"
            ) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception as exc:
        _note_err(exc)

    storage = get_storage()
    for r in rows:
        try:
            r["last_poll"] = await storage.get_collector_last_poll(r["id"])
        except Exception:
            r["last_poll"] = None

    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r['name']))}</td><td>{html.escape(str(r.get('ip') or ''))}</td>"
            f"<td>{_status_badge(r.get('status'))}</td>"
            f"<td>{html.escape(_fmt_ts(r.get('last_poll') or r.get('last_seen')))}</td></tr>"
            for r in rows
        )
        body = ("<table><thead><tr><th>Collector</th><th>Address</th><th>Status</th><th>Last Poll</th></tr></thead>"
                f"<tbody>{trs}</tbody></table>")
    else:
        body = _empty('No collectors registered')
    return HTMLResponse(_page("Collector Status", body))


# ── Param option pickers ──────────────────────────────────────────────────────
# Every picker reads live state rather than a static list, so a device added or
# removed after a NOC screen was built shows up (or drops out) on the next time
# the editor opens the param — no manifest edit and no pktHub change needed. The
# same applies to metrics: `oid_labels` is whatever the poller has actually seen,
# so a newly-polled OID becomes selectable without any code change here.
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


@router.get("/options/oid_labels")
async def widget_options_oid_labels(device_id: int | None = None):
    """Metrics actually present in the timeseries store. Scoped to one device
    when the widget has already picked one, so the list stays relevant."""
    try:
        if device_id:
            rows = await get_storage().get_device_latest(device_id)
            labels = sorted({str(r["oid_label"]) for r in rows if r.get("oid_label")})
        else:
            async with aiosqlite.connect(_DB) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    "SELECT DISTINCT oid_label FROM snmp_latest WHERE oid_label IS NOT NULL ORDER BY oid_label"
                ) as cur:
                    labels = [str(r["oid_label"]) for r in await cur.fetchall()]
        return JSONResponse([{"value": lbl, "label": lbl} for lbl in labels])
    except Exception:
        return JSONResponse([])


@router.get("/options/interfaces")
async def widget_options_interfaces(device_id: int | None = None):
    if not device_id:
        return JSONResponse([])
    try:
        ifaces = await get_storage().get_device_interfaces(device_id)
        seen, opts = set(), []
        for i in ifaces:
            label = str(i.get("interface_label") or i.get("name") or "")
            if label and label not in seen:
                seen.add(label)
                opts.append({"value": label, "label": str(i.get("name") or label)})
        return JSONResponse(sorted(opts, key=lambda o: o["label"]))
    except Exception:
        return JSONResponse([])
