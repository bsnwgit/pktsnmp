"""
app/api/alerts.py — Alert rules and alert events REST API
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from fastapi import Depends
from app.database import get_db
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()

# ── Helpers ───────────────────────────────────────────────────────────────────

def _row_to_dict(row: aiosqlite.Row) -> dict:
    return dict(row)


# ═══════════════════════════════════════════════════════════════════════════════
# ALERT EVENTS
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/events")
async def list_events(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    acked: Optional[bool] = Query(None, description="Filter by acked status"),
    active: Optional[bool] = Query(None, description="If true, only unresolved events"),
    limit: int = Query(200, ge=1, le=2000),
    since: Optional[str] = Query(None, description="ISO datetime lower bound"),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    clauses = []
    params: list = []

    if acked is not None:
        clauses.append("e.acked_at IS " + ("NOT NULL" if acked else "NULL"))
    if active is True:
        clauses.append("e.resolved_at IS NULL")
    if since:
        clauses.append("e.fired_at >= ?")
        params.append(since)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)

    sql = f"""
        SELECT
            e.id, e.severity, e.message, e.details,
            e.fired_at, e.acked_at, e.resolved_at,
            e.device_id,
            r.id   AS rule_id,
            r.name AS rule_name,
            r.rule_type,
            u.username AS acked_by,
            d.name AS device_name,
            d.ip   AS device_ip
        FROM alert_events e
        JOIN  alert_rules r ON r.id = e.rule_id
        LEFT JOIN users   u ON u.id = e.acked_by
        LEFT JOIN devices d ON d.id = e.device_id
        {where}
        ORDER BY e.fired_at DESC
        LIMIT ?
    """
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/events/{event_id}/ack")
async def ack_event(
    event_id: int,
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id FROM alert_events WHERE id=?", (event_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE id=?",
        (user["id"], event_id),
    )
    await db.commit()
    return {"ok": True}


@router.post("/events/ack-all")
async def ack_all_events(
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE acked_at IS NULL",
        (user["id"],),
    )
    await db.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# ALERT RULES
# ═══════════════════════════════════════════════════════════════════════════════

BUILTIN_IDS = {1, 2}  # protect built-in rules from deletion

class RuleIn(BaseModel):
    name: str
    description: str = ""
    rule_type: str = "threshold"
    conditions: dict = {}
    time_window_min: int = 5
    severity: str = "warning"
    channels: list[str] = ["inapp"]
    cooldown_min: int = 30
    enabled: bool = True


@router.get("/rules")
async def list_rules(
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> list[dict]:
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT *, (id IN (1,2)) AS builtin FROM alert_rules ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        # Parse JSON fields
        try:
            d["conditions"] = json.loads(d["conditions"])
        except Exception:
            d["conditions"] = {}
        try:
            d["channels"] = json.loads(d["channels"])
        except Exception:
            d["channels"] = ["inapp"]
        result.append(d)
    return result


@router.post("/rules", status_code=201)
async def create_rule(
    body: RuleIn,
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute(
        """
        INSERT INTO alert_rules
            (name, description, rule_type, conditions, time_window_min,
             severity, channels, cooldown_min, enabled, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        (
            body.name, body.description, body.rule_type,
            json.dumps(body.conditions), body.time_window_min,
            body.severity, json.dumps(body.channels),
            body.cooldown_min, int(body.enabled), user["id"],
        ),
    ) as cur:
        rule_id = cur.lastrowid
    await db.commit()
    return {"id": rule_id}


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: int,
    body: RuleIn,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.execute(
        """
        UPDATE alert_rules SET
            name=?, description=?, rule_type=?, conditions=?,
            time_window_min=?, severity=?, channels=?, cooldown_min=?,
            enabled=?, updated_at=datetime('now')
        WHERE id=?
        """,
        (
            body.name, body.description, body.rule_type,
            json.dumps(body.conditions), body.time_window_min,
            body.severity, json.dumps(body.channels),
            body.cooldown_min, int(body.enabled), rule_id,
        ),
    )
    await db.commit()
    return {"ok": True}


@router.post("/rules/{rule_id}/toggle")
async def toggle_rule(
    rule_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    async with db.execute("SELECT id, enabled FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    new_val = 0 if row[1] else 1
    await db.execute(
        "UPDATE alert_rules SET enabled=?, updated_at=datetime('now') WHERE id=?",
        (new_val, rule_id),
    )
    await db.commit()
    return {"enabled": bool(new_val)}


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: int,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    if rule_id in BUILTIN_IDS:
        raise HTTPException(status_code=400, detail="Cannot delete built-in rules")
    async with db.execute("SELECT id FROM alert_rules WHERE id=?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.execute("DELETE FROM alert_events WHERE rule_id=?", (rule_id,))
    await db.execute("DELETE FROM alert_rules WHERE id=?", (rule_id,))
    await db.commit()
