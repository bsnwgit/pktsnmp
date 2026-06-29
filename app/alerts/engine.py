"""
Alert engine — evaluates alert rules on a schedule and fires/resolves alert events.

Runs every 60 seconds. Implements:
  - device_down:          fires when a device's last_seen is stale OR status='down'.
                          Auto-resolves when device comes back up.
  - interface_down:       fires when ifOperStatus=0 for >= time_window_min.
  - interface_flap:       fires when interface status changes > N times in window.
  - metric_threshold:     fires when an OID value (or computed rate) crosses a threshold.
  - metric_spike:         fires when a recent mean is N× above the window baseline.
  - error_rate:           fires when ifInErrors or ifOutErrors rate exceeds threshold.
  - discard_rate:         fires when ifInDiscards or ifOutDiscards rate exceeds threshold.
  - high_error_ratio:     fires when errors/packets > threshold %.
  - bandwidth_utilization:fires when octet rate / ifSpeed > threshold %.
  - speed_change:         fires when ifSpeedMetric changes by > delta %.
  - collector_gap:        fires when no polls arrive from a collector for silence_minutes.
  - device_unreachable:   fires when no polls arrive for a specific device for silence_minutes.
  - trap_received:        fires when a trap matching a target OID is received.
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
        try:
            await asyncio.wait_for(asyncio.shield(self._stop_event.wait()), timeout=15)
        except asyncio.TimeoutError:
            pass

        while not self._stop_event.is_set():
            try:
                await self._evaluate_rules()
            except Exception as exc:
                log.error("Alert engine evaluation error: %s", exc, exc_info=True)

            try:
                await asyncio.wait_for(
                    asyncio.shield(self._stop_event.wait()), timeout=self._interval
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

            async with db.execute(
                """SELECT id, name, rule_type, conditions, severity,
                          cooldown_min, time_window_min
                   FROM alert_rules WHERE enabled=1"""
            ) as cur:
                rules = [dict(r) for r in await cur.fetchall()]

            async with db.execute(
                "SELECT id, name, ip, status, enabled, last_seen, collector_id FROM devices WHERE enabled=1"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]

            async with db.execute("SELECT id, name, ip FROM collectors") as cur:
                collectors = [dict(r) for r in await cur.fetchall()]

            now = datetime.now(tz=timezone.utc)

            for rule in rules:
                try:
                    conditions = json.loads(rule["conditions"]) if rule["conditions"] else {}
                except Exception:
                    conditions = {}

                rt = rule["rule_type"]
                try:
                    if rt == "device_down":
                        await self._eval_device_down(db, rule, conditions, devices, now)
                    elif rt == "interface_down":
                        await self._eval_interface_down(db, rule, conditions, devices, now)
                    elif rt == "interface_flap":
                        await self._eval_interface_flap(db, rule, conditions, devices, now)
                    elif rt == "metric_threshold":
                        await self._eval_metric_threshold(db, rule, conditions, devices, now)
                    elif rt == "metric_spike":
                        await self._eval_metric_spike(db, rule, conditions, devices, now)
                    elif rt == "error_rate":
                        await self._eval_error_rate(db, rule, conditions, devices, now)
                    elif rt == "discard_rate":
                        await self._eval_discard_rate(db, rule, conditions, devices, now)
                    elif rt == "high_error_ratio":
                        await self._eval_high_error_ratio(db, rule, conditions, devices, now)
                    elif rt == "bandwidth_utilization":
                        await self._eval_bandwidth_utilization(db, rule, conditions, devices, now)
                    elif rt == "speed_change":
                        await self._eval_speed_change(db, rule, conditions, devices, now)
                    elif rt == "collector_gap":
                        await self._eval_collector_gap(db, rule, conditions, collectors, now)
                    elif rt == "device_unreachable":
                        await self._eval_device_unreachable(db, rule, conditions, devices, now)
                    elif rt == "trap_received":
                        await self._eval_trap_received(db, rule, conditions, devices, now)
                except Exception as exc:
                    log.error("Rule %r (%s) evaluation error: %s", rule["name"], rt, exc, exc_info=True)

            await db.commit()

    # ── device_down ───────────────────────────────────────────────────────────

    async def _eval_device_down(self, db, rule, conditions, devices, now) -> None:
        silence_minutes = int(conditions.get("silence_minutes", 10))
        cooldown_min    = int(rule.get("cooldown_min", 30))
        stale_threshold = timedelta(minutes=silence_minutes)

        for device in devices:
            device_id = device["id"]
            is_down   = False
            reason    = ""

            if device["status"] == "down":
                is_down = True
                reason  = "not responding to SNMP polls"
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
                        reason = f"no data for {mins}m (threshold {silence_minutes}m)"

            if is_down:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()

                await db.execute(
                    "UPDATE devices SET status='down', updated_at=datetime('now') WHERE id=?",
                    (device_id,),
                )

                if not existing:
                    message = (
                        f"Device unreachable — {device['name']} ({device['ip']}): {reason}"
                    )
                    await _fire(db, rule, device_id, message,
                                {"device_id": device_id, "ip": device["ip"]})
            else:
                await db.execute(
                    "UPDATE devices SET status='up', updated_at=datetime('now') WHERE id=?",
                    (device_id,),
                )
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Device back online: {device['name']}")

    # ── interface_down ────────────────────────────────────────────────────────

    async def _eval_interface_down(self, db, rule, conditions, devices, now) -> None:
        """Fire if ifOperStatus=0 for every sample in the last time_window_min minutes."""
        window_min   = int(rule.get("time_window_min", 5))
        cooldown_min = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            rows = await _poll_window(db, device_id, None, "ifOperStatusMetric", window_min)
            if not rows:
                continue

            # All samples down?
            all_down = all(r["value_numeric"] is not None and r["value_numeric"] < 1 for r in rows)
            if all_down:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = f"Interface down — {device['name']} ({device['ip']}): ifOperStatus=0 for {window_min}m"
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"], "window_min": window_min})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Interface restored: {device['name']}")

    # ── interface_flap ────────────────────────────────────────────────────────

    async def _eval_interface_flap(self, db, rule, conditions, devices, now) -> None:
        """Fire if status changes > flap_threshold times in time_window_min."""
        window_min      = int(rule.get("time_window_min", 10))
        cooldown_min    = int(rule.get("cooldown_min", 60))
        flap_threshold  = int(conditions.get("flap_threshold", 3))
        device_id_filter = conditions.get("device_id")

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            rows = await _poll_window(db, device_id, None, "ifOperStatusMetric", window_min)
            if len(rows) < 2:
                continue

            changes = sum(
                1 for i in range(1, len(rows))
                if rows[i]["value_numeric"] != rows[i-1]["value_numeric"]
            )

            if changes >= flap_threshold:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Interface flapping — {device['name']} ({device['ip']}): "
                        f"{changes} status changes in {window_min}m (threshold {flap_threshold})"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "changes": changes, "window_min": window_min})

    # ── metric_threshold ──────────────────────────────────────────────────────

    async def _eval_metric_threshold(self, db, rule, conditions, devices, now) -> None:
        """Fire when an OID value (or computed rate) crosses a threshold.

        conditions:
          oid_label   : str  — e.g. "ifInOctets"
          operator    : ">"|"<"|">="|"<="|"=="
          threshold   : float
          use_rate    : bool — compute bytes/s (for counter OIDs) before comparing
          device_id   : int  — optional, scopes to single device
        """
        oid_label        = conditions.get("oid_label", "")
        operator         = conditions.get("operator", ">")
        threshold        = float(conditions.get("threshold", 0))
        use_rate         = bool(conditions.get("use_rate", False))
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        if not oid_label:
            return

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            rows = await _poll_window(db, device_id, None, oid_label, window_min)
            if not rows:
                continue

            if use_rate:
                value = _avg_rate(rows)
            else:
                nums = [r["value_numeric"] for r in rows if r["value_numeric"] is not None]
                value = (sum(nums) / len(nums)) if nums else None

            if value is None:
                continue

            triggered = _compare(value, operator, threshold)
            if triggered:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Metric threshold — {device['name']} ({device['ip']}): "
                        f"{oid_label} {'rate' if use_rate else 'value'} "
                        f"{value:.2f} {operator} {threshold}"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "oid_label": oid_label, "value": value, "threshold": threshold})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Metric threshold cleared: {device['name']}")

    # ── metric_spike ──────────────────────────────────────────────────────────

    async def _eval_metric_spike(self, db, rule, conditions, devices, now) -> None:
        """Fire when the recent mean is spike_factor× above the baseline mean.

        conditions:
          oid_label    : str
          spike_factor : float  — e.g. 3.0 = 3× baseline
          recent_min   : int    — recent window in minutes (default: time_window_min)
          baseline_min : int    — baseline window in minutes (default: 60)
          device_id    : int    — optional
        """
        oid_label        = conditions.get("oid_label", "")
        spike_factor     = float(conditions.get("spike_factor", 3.0))
        recent_min       = int(conditions.get("recent_min") or rule.get("time_window_min", 5))
        baseline_min     = int(conditions.get("baseline_min", 60))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        if not oid_label:
            return

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            recent_rows   = await _poll_window(db, device_id, None, oid_label, recent_min)
            baseline_rows = await _poll_window(db, device_id, None, oid_label, baseline_min)
            if not recent_rows or not baseline_rows:
                continue

            recent_avg   = _safe_mean([r["value_numeric"] for r in recent_rows])
            baseline_avg = _safe_mean([r["value_numeric"] for r in baseline_rows])
            if recent_avg is None or baseline_avg is None or baseline_avg == 0:
                continue

            if recent_avg > baseline_avg * spike_factor:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Metric spike — {device['name']} ({device['ip']}): "
                        f"{oid_label} recent avg {recent_avg:.1f} is "
                        f"{recent_avg/baseline_avg:.1f}× baseline ({baseline_avg:.1f})"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "oid_label": oid_label, "recent_avg": recent_avg,
                                 "baseline_avg": baseline_avg, "factor": recent_avg/baseline_avg})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Metric spike cleared: {device['name']}")

    # ── error_rate ────────────────────────────────────────────────────────────

    async def _eval_error_rate(self, db, rule, conditions, devices, now) -> None:
        """Fire when average error rate (errors/sec) exceeds threshold.

        conditions:
          direction  : "in"|"out"|"both"
          threshold  : float  — errors per second
          device_id  : int    — optional
        """
        direction        = conditions.get("direction", "both")
        threshold        = float(conditions.get("threshold", 1.0))
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        oid_map = {"in": ["ifInErrors"], "out": ["ifOutErrors"],
                   "both": ["ifInErrors", "ifOutErrors"]}
        oids = oid_map.get(direction, ["ifInErrors", "ifOutErrors"])

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            triggered_oid = None
            triggered_val = 0.0
            for oid in oids:
                rows = await _poll_window(db, device_id, None, oid, window_min)
                rate = _avg_rate(rows)
                if rate is not None and rate > threshold:
                    triggered_oid = oid
                    triggered_val = rate
                    break

            if triggered_oid:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Error rate — {device['name']} ({device['ip']}): "
                        f"{triggered_oid} rate {triggered_val:.2f}/s > threshold {threshold}/s"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "oid_label": triggered_oid, "rate": triggered_val})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Error rate cleared: {device['name']}")

    # ── discard_rate ──────────────────────────────────────────────────────────

    async def _eval_discard_rate(self, db, rule, conditions, devices, now) -> None:
        """Like error_rate but for discard counters."""
        direction        = conditions.get("direction", "both")
        threshold        = float(conditions.get("threshold", 1.0))
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        oid_map = {"in": ["ifInDiscards"], "out": ["ifOutDiscards"],
                   "both": ["ifInDiscards", "ifOutDiscards"]}
        oids = oid_map.get(direction, ["ifInDiscards", "ifOutDiscards"])

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            triggered_oid = None
            triggered_val = 0.0
            for oid in oids:
                rows = await _poll_window(db, device_id, None, oid, window_min)
                rate = _avg_rate(rows)
                if rate is not None and rate > threshold:
                    triggered_oid = oid
                    triggered_val = rate
                    break

            if triggered_oid:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Discard rate — {device['name']} ({device['ip']}): "
                        f"{triggered_oid} rate {triggered_val:.2f}/s > threshold {threshold}/s"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "oid_label": triggered_oid, "rate": triggered_val})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Discard rate cleared: {device['name']}")

    # ── high_error_ratio ──────────────────────────────────────────────────────

    async def _eval_high_error_ratio(self, db, rule, conditions, devices, now) -> None:
        """Fire when (error_rate / packet_rate) > threshold %.

        conditions:
          direction  : "in"|"out"|"both"
          threshold  : float  — percentage, e.g. 1.0 for 1%
          device_id  : int    — optional
        """
        direction        = conditions.get("direction", "both")
        threshold_pct    = float(conditions.get("threshold", 1.0))
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        pairs = []
        if direction in ("in", "both"):
            pairs.append(("ifInErrors", "ifInUcastPkts"))
        if direction in ("out", "both"):
            pairs.append(("ifOutErrors", "ifOutUcastPkts"))

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            triggered = False
            triggered_detail = ""
            for err_oid, pkt_oid in pairs:
                err_rows = await _poll_window(db, device_id, None, err_oid, window_min)
                pkt_rows = await _poll_window(db, device_id, None, pkt_oid, window_min)
                err_rate = _avg_rate(err_rows)
                pkt_rate = _avg_rate(pkt_rows)
                if err_rate is None or pkt_rate is None or pkt_rate == 0:
                    continue
                ratio_pct = (err_rate / pkt_rate) * 100
                if ratio_pct > threshold_pct:
                    triggered = True
                    triggered_detail = (
                        f"{err_oid} ratio {ratio_pct:.2f}% > threshold {threshold_pct}%"
                    )
                    break

            if triggered:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"High error ratio — {device['name']} ({device['ip']}): "
                        f"{triggered_detail}"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "detail": triggered_detail})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Error ratio cleared: {device['name']}")

    # ── bandwidth_utilization ─────────────────────────────────────────────────

    async def _eval_bandwidth_utilization(self, db, rule, conditions, devices, now) -> None:
        """Fire when (octet_rate * 8 / ifSpeed) > threshold %.

        conditions:
          direction   : "in"|"out"|"both"
          threshold   : float  — percentage, e.g. 80.0 for 80%
          device_id   : int    — optional
        """
        direction        = conditions.get("direction", "both")
        threshold_pct    = float(conditions.get("threshold", 80.0))
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        octets_oids = []
        if direction in ("in", "both"):
            octets_oids.append("ifInOctets")
        if direction in ("out", "both"):
            octets_oids.append("ifOutOctets")

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            # Get ifSpeed (bits/sec from SNMP, reported as-is by otelcol)
            speed_rows = await _poll_window(db, device_id, None, "ifSpeedMetric", window_min)
            speeds = [r["value_numeric"] for r in speed_rows if r["value_numeric"] and r["value_numeric"] > 0]
            if not speeds:
                continue
            if_speed_bps = speeds[-1]  # latest speed value

            triggered = False
            triggered_detail = ""
            for octet_oid in octets_oids:
                rows = await _poll_window(db, device_id, None, octet_oid, window_min)
                rate_octets = _avg_rate(rows)
                if rate_octets is None:
                    continue
                rate_bps = rate_octets * 8
                util_pct = (rate_bps / if_speed_bps) * 100
                if util_pct > threshold_pct:
                    triggered = True
                    triggered_detail = (
                        f"{octet_oid} utilization {util_pct:.1f}% > threshold {threshold_pct}% "
                        f"({rate_bps/1e6:.1f} Mbps of {if_speed_bps/1e6:.0f} Mbps)"
                    )
                    break

            if triggered:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Bandwidth utilization — {device['name']} ({device['ip']}): "
                        f"{triggered_detail}"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "detail": triggered_detail})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Bandwidth utilization cleared: {device['name']}")

    # ── speed_change ──────────────────────────────────────────────────────────

    async def _eval_speed_change(self, db, rule, conditions, devices, now) -> None:
        """Fire when ifSpeedMetric changes by more than delta_pct %.

        conditions:
          delta_pct  : float  — minimum % change to trigger (default 10%)
          device_id  : int    — optional
        """
        delta_pct        = float(conditions.get("delta_pct", 10.0))
        window_min       = int(rule.get("time_window_min", 15))
        cooldown_min     = int(rule.get("cooldown_min", 60))
        device_id_filter = conditions.get("device_id")

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            rows = await _poll_window(db, device_id, None, "ifSpeedMetric", window_min)
            speeds = [r["value_numeric"] for r in rows if r["value_numeric"] is not None]
            if len(speeds) < 2:
                continue

            first_speed = speeds[0]
            last_speed  = speeds[-1]
            if first_speed == 0:
                continue

            pct_change = abs(last_speed - first_speed) / first_speed * 100
            if pct_change > delta_pct:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Speed change — {device['name']} ({device['ip']}): "
                        f"ifSpeed changed {pct_change:.1f}% "
                        f"({first_speed/1e6:.0f}→{last_speed/1e6:.0f} Mbps)"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "old_speed": first_speed, "new_speed": last_speed,
                                 "pct_change": pct_change})

    # ── collector_gap ─────────────────────────────────────────────────────────

    async def _eval_collector_gap(self, db, rule, conditions, collectors, now) -> None:
        """Fire when no polls arrive from a collector in silence_minutes.

        conditions:
          collector_id     : int   — optional, checks all if omitted
          silence_minutes  : int
        """
        silence_minutes  = int(conditions.get("silence_minutes", 15))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        collector_id_filter = conditions.get("collector_id")

        for collector in collectors:
            if collector_id_filter and collector["id"] != int(collector_id_filter):
                continue
            collector_id = collector["id"]

            async with db.execute(
                """SELECT (julianday('now') - julianday(MAX(polled_at))) * 1440.0 AS minutes_ago
                   FROM snmp_poll_results
                   WHERE collector_id = ?""",
                [collector_id],
            ) as cur:
                row = await cur.fetchone()

            minutes_ago = row["minutes_ago"] if (row and row["minutes_ago"] is not None) else 9999
            is_gap = minutes_ago >= silence_minutes

            if is_gap:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                         AND json_extract(details, '$.collector_id') = ?
                       LIMIT 1""",
                    (rule["id"], f"-{cooldown_min} minutes", collector_id),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Collector gap — {collector['name']} (id={collector_id}): "
                        f"no polls for {int(minutes_ago)}m (threshold {silence_minutes}m)"
                    )
                    await _fire(db, rule, None, msg,
                                {"collector_id": collector_id, "name": collector["name"],
                                 "minutes_ago": int(minutes_ago)})
            else:
                # Resolve any open collector gap events
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND resolved_at IS NULL
                         AND json_extract(details, '$.collector_id') = ?
                       LIMIT 1""",
                    (rule["id"], collector_id),
                ) as cur:
                    open_ev = await cur.fetchone()
                if open_ev:
                    await db.execute(
                        """UPDATE alert_events SET resolved_at=datetime('now'), auto_resolved=1
                           WHERE rule_id=? AND resolved_at IS NULL
                             AND json_extract(details, '$.collector_id') = ?""",
                        (rule["id"], collector_id),
                    )
                    log.info("RESOLVED collector_gap rule=%r collector_id=%d", rule["name"], collector_id)

    # ── device_unreachable ────────────────────────────────────────────────────

    async def _eval_device_unreachable(self, db, rule, conditions, devices, now) -> None:
        """Fire when no polls arrive for a specific device in silence_minutes.
        Less aggressive than device_down — uses poll_results timestamps, not device.status.

        conditions:
          silence_minutes  : int
          device_id        : int  — optional, checks all devices if omitted
        """
        silence_minutes  = int(conditions.get("silence_minutes", 15))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        for device in devices:
            if device_id_filter and device["id"] != int(device_id_filter):
                continue
            device_id = device["id"]

            async with db.execute(
                """SELECT (julianday('now') - julianday(MAX(polled_at))) * 1440.0 AS minutes_ago
                   FROM snmp_poll_results WHERE device_id = ?""",
                [device_id],
            ) as cur:
                row = await cur.fetchone()

            minutes_ago = row["minutes_ago"] if (row and row["minutes_ago"] is not None) else 9999
            is_gap = minutes_ago >= silence_minutes

            if is_gap:
                async with db.execute(
                    """SELECT id FROM alert_events
                       WHERE rule_id=? AND device_id=? AND resolved_at IS NULL
                         AND fired_at >= datetime('now', ?)
                       LIMIT 1""",
                    (rule["id"], device_id, f"-{cooldown_min} minutes"),
                ) as cur:
                    existing = await cur.fetchone()
                if not existing:
                    msg = (
                        f"Device poll gap — {device['name']} ({device['ip']}): "
                        f"no SNMP data for {int(minutes_ago)}m (threshold {silence_minutes}m)"
                    )
                    await _fire(db, rule, device_id, msg,
                                {"device_id": device_id, "ip": device["ip"],
                                 "minutes_ago": int(minutes_ago)})
            else:
                await _auto_resolve(db, rule["id"], device_id,
                                    f"Device polling resumed: {device['name']}")

    # ── trap_received ─────────────────────────────────────────────────────────

    async def _eval_trap_received(self, db, rule, conditions, devices, now) -> None:
        """Fire when a trap matching a target OID prefix is received within time_window_min.

        conditions:
          trap_oid_prefix : str  — OID prefix to match (LIKE match, empty = any trap)
          device_id       : int  — optional, filter to specific device
        """
        trap_oid_prefix  = conditions.get("trap_oid_prefix", "")
        window_min       = int(rule.get("time_window_min", 5))
        cooldown_min     = int(rule.get("cooldown_min", 30))
        device_id_filter = conditions.get("device_id")

        # Look for matching traps in the time window
        if trap_oid_prefix:
            oid_condition = " AND trap_oid LIKE ?"
            oid_params    = [f"{trap_oid_prefix}%"]
        else:
            oid_condition = ""
            oid_params    = []

        if device_id_filter:
            dev_condition = " AND device_id = ?"
            dev_params    = [int(device_id_filter)]
        else:
            dev_condition = ""
            dev_params    = []

        window_param = f"-{window_min} minutes"
        async with db.execute(
            f"""SELECT id, received_at, trap_oid, source_ip, device_id
                FROM snmp_traps
                WHERE received_at >= datetime('now', ?)
                  {oid_condition} {dev_condition}
                ORDER BY received_at DESC LIMIT 20""",
            [window_param] + oid_params + dev_params,
        ) as cur:
            traps = [dict(r) for r in await cur.fetchall()]

        if traps:
            t = traps[0]
            trap_device_id = t.get("device_id")

            async with db.execute(
                """SELECT id FROM alert_events
                   WHERE rule_id=? AND resolved_at IS NULL
                     AND fired_at >= datetime('now', ?)
                   LIMIT 1""",
                (rule["id"], f"-{cooldown_min} minutes"),
            ) as cur:
                existing = await cur.fetchone()

            if not existing:
                # Look up device name if we have an id
                dev_name = t.get("source_ip", "unknown")
                if trap_device_id:
                    for d in devices:
                        if d["id"] == trap_device_id:
                            dev_name = f"{d['name']} ({d['ip']})"
                            break

                msg = (
                    f"Trap received — {dev_name}: "
                    f"OID {t.get('trap_oid', '—')} "
                    f"({len(traps)} in {window_min}m)"
                )
                await _fire(db, rule, trap_device_id, msg,
                            {"trap_oid": t.get("trap_oid"), "source_ip": t.get("source_ip"),
                             "device_id": trap_device_id, "count": len(traps)})


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _poll_window(
    db: aiosqlite.Connection,
    device_id: int | None,
    device_ip: str | None,
    oid_label: str,
    window_min: int,
) -> list[dict]:
    """Return rows for device+OID in the last window_min minutes, oldest first."""
    if device_id is not None:
        cond, param = "device_id = ?", device_id
    elif device_ip is not None:
        cond, param = "device_ip = ?", device_ip
    else:
        return []
    async with db.execute(
        f"""SELECT polled_at, value_numeric
            FROM snmp_poll_results
            WHERE {cond} AND oid_label = ?
              AND polled_at >= datetime('now', ?)
            ORDER BY polled_at ASC""",
        [param, oid_label, f"-{window_min} minutes"],
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


def _avg_rate(rows: list[dict]) -> float | None:
    """Compute mean bytes/packets per second from a list of ordered counter rows."""
    if len(rows) < 2:
        return None
    rates = []
    for i in range(1, len(rows)):
        t1 = _parse_ts(rows[i-1]["polled_at"])
        t2 = _parse_ts(rows[i]["polled_at"])
        v1 = rows[i-1]["value_numeric"]
        v2 = rows[i]["value_numeric"]
        if t1 is None or t2 is None or v1 is None or v2 is None:
            continue
        dt = (t2 - t1).total_seconds()
        if dt <= 0 or v2 < v1:
            continue
        rates.append((v2 - v1) / dt)
    if not rates:
        return None
    return sum(rates) / len(rates)


def _safe_mean(vals: list) -> float | None:
    nums = [v for v in vals if v is not None]
    return sum(nums) / len(nums) if nums else None


def _compare(value: float, operator: str, threshold: float) -> bool:
    ops = {">": value > threshold, ">=": value >= threshold,
           "<": value < threshold, "<=": value <= threshold, "==": value == threshold}
    return ops.get(operator, False)


async def _fire(
    db: aiosqlite.Connection,
    rule: dict,
    device_id: int | None,
    message: str,
    details: dict,
) -> None:
    await db.execute(
        """INSERT INTO alert_events
               (rule_id, device_id, severity, message, details, fired_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))""",
        (rule["id"], device_id, rule["severity"], message, json.dumps(details)),
    )
    await db.execute(
        "UPDATE alert_rules SET last_fired=datetime('now') WHERE id=?",
        (rule["id"],),
    )
    log.warning("ALERT fired  rule=%r  device_id=%s  msg=%s", rule["name"], device_id, message)


async def _auto_resolve(
    db: aiosqlite.Connection,
    rule_id: int,
    device_id: int | None,
    note: str,
) -> None:
    if device_id is None:
        return
    async with db.execute(
        """SELECT COUNT(*) FROM alert_events
           WHERE rule_id=? AND device_id=? AND resolved_at IS NULL""",
        (rule_id, device_id),
    ) as cur:
        row = await cur.fetchone()
        open_count = row[0] if row else 0

    if open_count:
        await db.execute(
            """UPDATE alert_events SET resolved_at=datetime('now'), auto_resolved=1
               WHERE rule_id=? AND device_id=? AND resolved_at IS NULL""",
            (rule_id, device_id),
        )
        log.info("RESOLVED  rule_id=%d  device_id=%d  note=%s", rule_id, device_id, note)


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        s = ts.strip().replace(" ", "T")
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
