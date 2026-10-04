"""
/api/dashboard — everything the Dashboard page's history charts draw, in one read.

One request instead of one per panel, so the trend, the leaderboards and the
breakdowns all describe the same moment. Device counts and the trap panels stay
on /api/snmp/dashboard — this is the half that follows the window picker.

Everything here reads the control database or goes through the storage
interface (get_all_devices_latest), never a backend's connection, so it behaves
the same on SQLite, DuckDB and ClickHouse.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, Query

from app.database import get_db
from app.dependencies import CurrentUser

router = APIRouter()

# Window (hours) -> bucket width (seconds); each step keeps the point count at 48-170.
_BUCKET_SECONDS = {1: 60, 6: 300, 24: 900, 168: 3600}
_TOP_N = 8
# A device that stopped answering keeps its last reading forever; a leaderboard
# of machines that have since gone dark would report load that no longer exists.
_FRESH_MINUTES = 30


def _bucket_for(hours: int) -> int:
    for limit in sorted(_BUCKET_SECONDS):
        if hours <= limit:
            return _BUCKET_SECONDS[limit]
    return 3600


def _utc(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


async def _alert_trend(db: aiosqlite.Connection, since: str, bucket: int) -> list[dict]:
    async with db.execute(
        """SELECT CAST(strftime('%s', fired_at) AS INTEGER) / ? AS b, severity, COUNT(*) AS n
           FROM alert_events WHERE fired_at >= ?
           GROUP BY b, severity ORDER BY b""",
        (bucket, since),
    ) as cur:
        rows = await cur.fetchall()
    by_bucket: dict[int, dict] = {}
    for r in rows:
        point = by_bucket.setdefault(
            r["b"], {"t": r["b"] * bucket * 1000, "critical": 0, "warning": 0, "info": 0}
        )
        point[r["severity"]] = r["n"]
    return [by_bucket[b] for b in sorted(by_bucket)]


async def _top_cpu(db: aiosqlite.Connection) -> list[dict]:
    from app.storage.factory import get_storage

    async with db.execute("SELECT id, name FROM devices WHERE enabled = 1") as cur:
        names = {r["id"]: r["name"] for r in await cur.fetchall()}
    if not names:
        return []

    fresh = _utc(datetime.now(timezone.utc) - timedelta(minutes=_FRESH_MINUTES))
    latest = await get_storage().get_all_devices_latest(list(names))
    out = []
    for did, rows in latest.items():
        # hrProcessorLoad is one row per core; the device's figure is their mean.
        # polled_at is T-format on SQLite and space-format on DuckDB, and the
        # space form sorts below the T form, so normalise before comparing.
        vals = [
            r["value_numeric"] for r in rows
            if r["oid_label"] == "hrProcessorLoad" and r["value_numeric"] is not None
            and str(r["polled_at"] or "").replace("T", " ")[:19] >= fresh
        ]
        if vals:
            out.append({"id": did, "name": names[did], "value": sum(vals) / len(vals)})
    out.sort(key=lambda r: r["value"], reverse=True)
    return out[:_TOP_N]


@router.get("")
async def get_dashboard_charts(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    hours: int = Query(24, ge=1, le=168),
) -> dict:
    db.row_factory = aiosqlite.Row
    since = _utc(datetime.now(timezone.utc) - timedelta(hours=hours))
    bucket = _bucket_for(hours)

    async with db.execute(
        """SELECT r.id, r.name, COUNT(*) AS n
           FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
           WHERE e.fired_at >= ? GROUP BY r.id ORDER BY n DESC LIMIT ?""",
        (since, _TOP_N),
    ) as cur:
        top_rules = [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in await cur.fetchall()]

    async with db.execute(
        """SELECT d.id, d.name, COUNT(*) AS n
           FROM alert_events e JOIN devices d ON d.id = e.device_id
           WHERE e.fired_at >= ? GROUP BY d.id ORDER BY n DESC LIMIT ?""",
        (since, _TOP_N),
    ) as cur:
        top_devices = [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in await cur.fetchall()]

    async with db.execute(
        """SELECT COALESCE(NULLIF(device_type, ''), 'unclassified') AS t, COUNT(*) AS n
           FROM devices GROUP BY t ORDER BY n DESC"""
    ) as cur:
        by_type = [{"type": r["t"], "count": r["n"]} for r in await cur.fetchall()]

    return {
        "hours": hours,
        "bucket_seconds": bucket,
        "alert_trend": await _alert_trend(db, since, bucket),
        "top_rules": top_rules,
        "top_devices": top_devices,
        "by_type": by_type,
        "top_cpu": await _top_cpu(db),
    }
