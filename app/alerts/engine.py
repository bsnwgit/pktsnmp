"""
Alert engine — evaluates alert rules on a schedule and fires/resolves alert events.

Runs every 60 seconds. Implements:
  - device_down: fires when a device's last_seen is stale OR status='down'.
                 Auto-resolves when device comes back up.
  - threshold:   reserved for future OID threshold alerting.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

import aiosqlite

from app.config import get_settings

log = logging.getLogger("pktsnmp.alerts.engine")


class AlertEngine:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._interval: int = 60  # evaluate rules every 60 seconds

    async def start(self, db_path: str = None) -> None:
        # db_path is accepted for API compatibility but ignored —
        # the engine reads db_path from settings at eval time.
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="alert_engine")
        log.info("Alert engine started (interval=%ds)", self._interval)

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("Alert engine stopped")

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def _run(self) -> None:
        # Stagger the first evaluation 15s after startup to let the rest of the
        # app fully initialise before we start writing to the DB.
        try:
            await asyncio.wait_for(
                asyncio.shield(self._stop_event.wait()), timeout=15
            )
        except asyncio.TimeoutError:
            pass

        while not self._stop_event.is_set():
            try:
                await self._evaluate_rules()
            except Exception as exc:
                log.error("Alert engine evaluation error: %s", exc, exc_info=True)

            try:
                await asyncio.wait_for(
                    asyncio.shield(self._stop_event.wait()),
                    timeout=self._interval,
                )
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                break

    # ── Rule evaluation ───────────────────────────────────────────────────────

    async def _evaluate_rules(self) -> None:
        db_path = get_settings().db_path
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row

            # Load all enabled rules
            async with db.execute(
                "SELECT id, name, rule_type, conditions, severity, cooldown_min "
                "FROM alert_rules WHERE enabled=1"
            ) as cur:
                rules = [dict(r) for r in await cur.fetchall()]

            # Load all enabled devices
            async with db.execute(
                "SELECT id, name, ip, status, enabled, last_seen FROM devices WHERE enabled=1"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]

            now = datetime.now(tz=timezone.utc)

            for rule in rules:
                try:
                    conditions = json.loads(rule["conditions"]) if rule["conditions"] else {}
                except Exception:
                    conditions = {}

                if rule["rule_type"] == "device_down":
                    await self._eval_device_down(db, rule, conditions, devices, now)
                # threshold and other rule types: reserved for future implementation

            await db.commit()

    # ── device_down ───────────────────────────────────────────────────────────

    async def _eval_device_down(
        self,
        db: aiosqlite.Connection,
        rule: dict,
        conditions: dict,
        devices: list[dict],
        now: datetime,
    ) -> None:
        silence_minutes = int(conditions.get("silence_minutes", 10))
        cooldown_min    = int(rule.get("cooldown_min", 30))
        stale_threshold = timedelta(minutes=silence_minutes)

        for device in devices:
            device_id = device["id"]
            is_down   = False
            reason    = ""

            # ── determine if device is considered down ────────────────────────
            if device["status"] == "down":
                is_down = True
                reason  = f"not responding to SNMP polls"

            elif device["last_seen"] is None:
                is_down = True
                reason  = "never reported data"

            else:
                last_seen = _parse_ts(device["last_seen"])
                if last_seen is not None:
                    staleness = now - last_seen
                    if staleness > stale_threshold:
                        is_down = True
                        mins = int(staleness.total_seconds() / 60)
                        reason = (
                            f"no data for {mins}m "
                            f"(threshold {silence_minutes}m)"
                        )

            # ── fire or resolve ───────────────────────────────────────────────
            if is_down:
                # Check cooldown: skip if we already have an open (unresolved)
                # event for this rule+device within the cooldown window.
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=?
                         AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()

                # Always mark device status=down so the dashboard dot goes red
                await db.execute(
                    "UPDATE devices SET status='down', updated_at=datetime('now') WHERE id=?",
                    (device_id,),
                )

                if not existing:
                    message = (
                        f"Device unreachable — {device['name']} ({device['ip']}): "
                        f"{reason}"
                    )
                    await db.execute(
                        """INSERT INTO alert_events
                               (rule_id, device_id, severity, message, details, fired_at)
                           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
                        (
                            rule["id"],
                            device_id,
                            rule["severity"],
                            message,
                            json.dumps({"device_id": device_id, "ip": device["ip"]}),
                        ),
                    )
                    log.warning(
                        "ALERT fired  rule=%r  device=%r (%s)  reason=%s",
                        rule["name"], device["name"], device["ip"], reason,
                    )

            else:
                # Device is back up — resolve any open events and restore status
                await db.execute(
                    "UPDATE devices SET status='up', updated_at=datetime('now') WHERE id=?",
                    (device_id,),
                )
                async with db.execute(
                    """SELECT COUNT(*) FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL""",
                    (rule["id"], device_id),
                ) as cur:
                    row = await cur.fetchone()
                    open_count = row[0] if row else 0

                if open_count:
                    await db.execute(
                        """UPDATE alert_events SET resolved_at=datetime('now')
                           WHERE rule_id=? AND device_id=? AND resolved_at IS NULL""",
                        (rule["id"], device_id),
                    )
                    log.info(
                        "RESOLVED      rule=%r  device=%r (%s)  events=%d",
                        rule["name"], device["name"], device["ip"], open_count,
                    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_ts(ts: str | None) -> datetime | None:
    """Parse a SQLite/ISO datetime string to a timezone-aware datetime, or None."""
    if not ts:
        return None
    try:
        s = ts.strip()
        # Normalise SQLite space-separator and bare UTC strings
        s = s.replace(" ", "T")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        elif "+" not in s and s.count("-") < 3:
            s += "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None
