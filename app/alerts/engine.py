"""
Alert engine -- evaluates enabled alert rules against incoming SNMP data and fires
alert_events into SQLite, then dispatches to configured notification channels.

Rule types handled:
  Trap-driven:    unknown_trap_source, trap_oid_match, trap_rate_spike
  Poll-driven:    oid_threshold, poll_failure (via failure_handler)
  Background:     device_down, oid_missing  (checked every 60 s)

Auto-resolve: device_down events are auto-resolved when a poll result arrives.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any

import aiosqlite

log = logging.getLogger("pktsnmp.alerts.engine")


class AlertEngine:
    def __init__(self) -> None:
        self._db_path: str = ""
        self._rules: list[dict] = []
        self._rules_lock = asyncio.Lock()
        # Cooldown: (rule_id, context_key) -> datetime last fired
        self._last_fired: dict[tuple, datetime] = {}
        # Trap rate tracking: window_key -> deque of datetimes
        self._trap_rate: dict[str, deque] = defaultdict(deque)
        # Poll failure counts: device_id -> consecutive failures
        self._poll_failures: dict[int, int] = defaultdict(int)
        # OIDs seen per device: device_id -> set of oid/oid_label strings
        self._device_oids_seen: dict[int, set] = defaultdict(set)
        self._background_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    # -- Lifecycle ------------------------------------------------------------

    async def start(self, db_path: str) -> None:
        self._db_path = db_path
        await self._load_rules()
        self._background_task = asyncio.create_task(
            self._background_loop(), name="alert_engine_bg"
        )
        log.info(f"Alert engine started -- {len(self._rules)} enabled rules")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._background_task:
            self._background_task.cancel()
            try:
                await self._background_task
            except asyncio.CancelledError:
                pass
        log.info("Alert engine stopped")

    async def reload_rules(self) -> None:
        await self._load_rules()
        log.info(f"Alert rules reloaded -- {len(self._rules)} enabled rules")

    # -- Public API -----------------------------------------------------------

    async def process_trap(self, trap: dict) -> None:
        async with self._rules_lock:
            rules = list(self._rules)
        for rule in rules:
            try:
                await self._eval_trap_rule(rule, trap)
            except Exception as e:
                log.debug(f"Trap rule {rule['id']} eval error: {e}")

    async def process_poll_result(self, result: dict) -> None:
        device_id = result.get("device_id")
        if device_id is not None:
            self._poll_failures[device_id] = 0
            oid_label = result.get("oid_label") or result.get("oid") or ""
            if oid_label:
                self._device_oids_seen[device_id].add(oid_label)
            await self._auto_resolve_device_down(device_id, result.get("device_ip", ""))
        async with self._rules_lock:
            rules = list(self._rules)
        for rule in rules:
            try:
                await self._eval_poll_rule(rule, result)
            except Exception as e:
                log.debug(f"Poll rule {rule['id']} eval error: {e}")

    async def process_poll_failure(self, device_id: int, device_ip: str) -> None:
        self._poll_failures[device_id] = self._poll_failures.get(device_id, 0) + 1
        count = self._poll_failures[device_id]
        async with self._rules_lock:
            rules = [r for r in self._rules if r["rule_type"] == "poll_failure"]
        for rule in rules:
            cond = rule.get("conditions", {})
            ip_filter = cond.get("device_ip", "")
            if ip_filter and ip_filter != device_ip:
                continue
            threshold = int(cond.get("threshold_count", 3))
            if count >= threshold:
                await self._fire(
                    rule,
                    f"Poll failure threshold reached for {device_ip} ({count} consecutive failures)",
                    {"device_ip": device_ip, "failure_count": count},
                    context_key=device_id,
                )

    # -- Rule evaluators ------------------------------------------------------

    async def _eval_trap_rule(self, rule: dict, trap: dict) -> None:
        rt = rule["rule_type"]
        cond = rule.get("conditions", {})
        source_ip = trap.get("source_ip", "")

        if rt == "unknown_trap_source":
            async with aiosqlite.connect(self._db_path) as db:
                async with db.execute(
                    "SELECT id FROM devices WHERE ip=?", (source_ip,)
                ) as cur:
                    exists = await cur.fetchone()
            if not exists:
                await self._fire(
                    rule,
                    f"Trap received from unregistered device {source_ip}",
                    {
                        "source_ip": source_ip,
                        "trap_oid": trap.get("trap_oid", ""),
                        "version": trap.get("snmp_version", ""),
                    },
                    context_key=source_ip,
                )

        elif rt == "trap_oid_match":
            target_oid = cond.get("oid", "")
            ip_filter = cond.get("device_ip", "")
            if not target_oid:
                return
            if ip_filter and ip_filter != source_ip:
                return
            oids_in_trap: set[str] = {trap.get("trap_oid", "")}
            for vb in trap.get("varbinds", []):
                oids_in_trap.add(vb.get("oid", ""))
            if target_oid in oids_in_trap:
                await self._fire(
                    rule,
                    f"Trap OID {target_oid} matched from {source_ip}",
                    {
                        "source_ip": source_ip,
                        "oid": target_oid,
                        "trap_oid": trap.get("trap_oid", ""),
                    },
                    context_key=(source_ip, target_oid),
                )

        elif rt == "trap_rate_spike":
            ip_filter = cond.get("device_ip", "")
            if ip_filter and ip_filter != source_ip:
                return
            window_key = ip_filter if ip_filter else "__all__"
            threshold = int(cond.get("threshold_per_minute", 60))
            now = datetime.now(tz=timezone.utc)
            dq = self._trap_rate[window_key]
            dq.append(now)
            cutoff = now - timedelta(minutes=1)
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= threshold:
                label = ip_filter if ip_filter else "all sources"
                await self._fire(
                    rule,
                    f"Trap rate spike: {len(dq)} traps/min from {label}",
                    {
                        "source_ip": source_ip if ip_filter else "multiple",
                        "rate_per_min": len(dq),
                        "threshold": threshold,
                    },
                    context_key=window_key,
                )

    async def _eval_poll_rule(self, rule: dict, result: dict) -> None:
        if rule["rule_type"] != "oid_threshold":
            return
        cond = rule.get("conditions", {})
        target_oid = cond.get("oid", "")
        ip_filter = cond.get("device_ip", "")
        if not target_oid:
            return
        device_ip = result.get("device_ip", "")
        if ip_filter and ip_filter != device_ip:
            return
        if target_oid not in (result.get("oid", ""), result.get("oid_label", "")):
            return
        value_numeric = result.get("value_numeric")
        if value_numeric is None:
            return
        threshold = float(cond.get("value", 0))
        operator = cond.get("operator", "gt")
        triggered = (
            (operator == "gt"  and value_numeric >  threshold) or
            (operator == "gte" and value_numeric >= threshold) or
            (operator == "lt"  and value_numeric <  threshold) or
            (operator == "lte" and value_numeric <= threshold)
        )
        if triggered:
            device_id = result.get("device_id")
            await self._fire(
                rule,
                f"OID {target_oid} value {value_numeric} {operator} {threshold} on {device_ip}",
                {
                    "device_ip": device_ip,
                    "oid": target_oid,
                    "value": value_numeric,
                    "threshold": threshold,
                    "operator": operator,
                },
                context_key=(device_id, target_oid),
            )

    # -- Background loop ------------------------------------------------------

    async def _background_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._stop_event.wait()), timeout=60.0
                )
                break
            except asyncio.TimeoutError:
                pass
            try:
                await self._check_device_down()
                await self._check_oid_missing()
            except Exception as e:
                log.error(f"Alert engine background loop error: {e}")

    async def _check_device_down(self) -> None:
        async with self._rules_lock:
            down_rules = [r for r in self._rules if r["rule_type"] == "device_down"]
        if not down_rules:
            return
        now = datetime.now(tz=timezone.utc)
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, ip, name, status, last_seen, collector_id FROM devices WHERE enabled=1"
            ) as cur:
                devices = [dict(r) for r in await cur.fetchall()]
        for rule in down_rules:
            cond = rule.get("conditions", {})
            silence_min = int(cond.get("silence_minutes", 10))
            ip_filter = cond.get("device_ip", "")
            for device in devices:
                if ip_filter and ip_filter != device["ip"]:
                    continue
                last_seen_raw = device.get("last_seen")
                if not last_seen_raw:
                    continue  # never had data -- skip
                # Remote collector devices (otelcol) are not polled locally.
                # Use a 6x longer silence window and a corrected message so we
                # don't falsely claim the local poller is failing for them.
                is_remote = int(device.get("collector_id") or 1) != 1
                effective_silence = silence_min * 6 if is_remote else silence_min
                try:
                    ls_dt = datetime.fromisoformat(last_seen_raw.replace("Z", "+00:00"))
                    if ls_dt.tzinfo is None:
                        ls_dt = ls_dt.replace(tzinfo=timezone.utc)
                    if (now - ls_dt).total_seconds() / 60 < effective_silence:
                        continue
                except Exception:
                    continue
                name = device.get("name") or device["ip"]
                if is_remote:
                    msg = f"Device {name} ({device['ip']}) — no data received from remote collector"
                else:
                    msg = f"Device {name} ({device['ip']}) is not responding to SNMP polls"
                await self._fire(
                    rule,
                    msg,
                    {
                        "device_ip": device["ip"],
                        "device_id": device["id"],
                        "last_seen": last_seen_raw,
                    },
                    context_key=device["id"],
                )

    async def _check_oid_missing(self) -> None:
        async with self._rules_lock:
            missing_rules = [r for r in self._rules if r["rule_type"] == "oid_missing"]
        if not missing_rules:
            return
        for rule in missing_rules:
            cond = rule.get("conditions", {})
            target_oid = cond.get("oid", "")
            ip_filter = cond.get("device_ip", "")
            if not target_oid:
                continue
            sql = "SELECT id, ip, name FROM devices WHERE enabled=1"
            params: list = []
            if ip_filter:
                sql += " AND ip=?"
                params.append(ip_filter)
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(sql, params) as cur:
                    devices = [dict(r) for r in await cur.fetchall()]
            for device in devices:
                seen = self._device_oids_seen.get(device["id"])
                if not seen:
                    continue
                if target_oid not in seen:
                    name = device.get("name") or device["ip"]
                    await self._fire(
                        rule,
                        f"OID {target_oid} missing from poll results for {name} ({device['ip']})",
                        {"device_ip": device["ip"], "oid": target_oid},
                        context_key=(device["id"], target_oid),
                    )

    # -- Auto-resolve ---------------------------------------------------------

    async def _auto_resolve_device_down(self, device_id: int, device_ip: str) -> None:
        try:
            async with aiosqlite.connect(self._db_path) as db:
                async with db.execute(
                    """SELECT e.id FROM alert_events e
                       JOIN alert_rules r ON r.id = e.rule_id
                       WHERE r.rule_type = 'device_down'
                         AND e.acked_at IS NULL
                         AND e.resolved_at IS NULL
                         AND json_extract(e.details, '$.device_id') = ?""",
                    (device_id,),
                ) as cur:
                    rows = await cur.fetchall()
                if rows:
                    ids = [r[0] for r in rows]
                    placeholders = ",".join("?" * len(ids))
                    await db.execute(
                        f"UPDATE alert_events SET resolved_at=datetime('now') WHERE id IN ({placeholders})",
                        ids,
                    )
                    await db.commit()
                    log.info(
                        f"Auto-resolved {len(ids)} device_down event(s) for device_id={device_id} ({device_ip})"
                    )
        except Exception as e:
            log.debug(f"Auto-resolve error for device {device_id}: {e}")

    # -- Internal helpers -----------------------------------------------------

    async def _load_rules(self) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM alert_rules WHERE enabled=1") as cur:
                rows = await cur.fetchall()
        rules: list[dict] = []
        for row in rows:
            r = dict(row)
            try:
                r["conditions"] = json.loads(r["conditions"])
            except Exception:
                r["conditions"] = {}
            try:
                r["channels"] = json.loads(r["channels"])
            except Exception:
                r["channels"] = ["inapp"]
            rules.append(r)
        async with self._rules_lock:
            self._rules = rules

    async def _fire(
        self,
        rule: dict,
        message: str,
        details: dict,
        context_key: Any = None,
    ) -> None:
        rule_id = rule["id"]
        ck = (rule_id, context_key)
        now = datetime.now(tz=timezone.utc)
        last = self._last_fired.get(ck)
        if last is not None:
            cooldown_secs = int(rule.get("cooldown_min", 30)) * 60
            if (now - last).total_seconds() < cooldown_secs:
                return
        self._last_fired[ck] = now
        try:
            async with aiosqlite.connect(self._db_path) as db:
                async with db.execute(
                    "INSERT INTO alert_events (rule_id, severity, message, details)"
                    " VALUES (?, ?, ?, ?) RETURNING id",
                    (rule_id, rule["severity"], message, json.dumps(details)),
                ) as cur:
                    row = await cur.fetchone()
                await db.execute(
                    "UPDATE alert_rules SET last_fired=datetime('now') WHERE id=?",
                    (rule_id,),
                )
                await db.commit()
            event_id = row[0]
            log.info(
                f"ALERT [{rule['severity'].upper()}] {rule['name']} -- {message} (event_id={event_id})"
            )
            asyncio.create_task(
                self._dispatch(rule, event_id, message, details),
                name=f"alert_dispatch_{event_id}",
            )
        except Exception as e:
            log.error(f"Alert engine _fire error (rule={rule_id}): {e}")

    # -- Notification dispatch ------------------------------------------------

    async def _dispatch(
        self, rule: dict, event_id: int, message: str, details: dict
    ) -> None:
        channels: list[str] = rule.get("channels", ["inapp"])
        non_inapp = [c for c in channels if c != "inapp"]
        if not non_inapp:
            return
        try:
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    "SELECT key, value FROM settings WHERE key LIKE 'notify_%'"
                ) as cur:
                    rows = await cur.fetchall()
            cfg: dict = {}
            for r in rows:
                try:
                    cfg[r["key"]] = json.loads(r["value"])
                except Exception:
                    cfg[r["key"]] = r["value"]
        except Exception as e:
            log.error(f"Dispatch: failed to load settings: {e}")
            return
        SEV_EMOJI = {"critical": "[CRIT]", "warning": "[WARN]", "info": "[INFO]"}
        title = f"{SEV_EMOJI.get(rule['severity'], '[ALRT]')} pktSNMP Alert: {rule['name']}"
        for channel in non_inapp:
            try:
                await self._send_channel(channel, rule, event_id, message, details, cfg, title)
            except Exception as e:
                log.warning(f"Dispatch failed channel={channel} event={event_id}: {e}")
                await self._log_notif(event_id, channel, "failed", str(e))

    async def _send_channel(
        self, channel: str, rule: dict, event_id: int,
        message: str, details: dict, cfg: dict, title: str,
    ) -> None:
        import httpx

        if channel == "slack":
            if not cfg.get("notify_slack_enabled"):
                await self._log_notif(event_id, channel, "skipped", "disabled"); return
            url = cfg.get("notify_slack_webhook_url", "")
            if not url:
                await self._log_notif(event_id, channel, "skipped", "no webhook URL"); return
            color = "#ff4444" if rule["severity"] == "critical" else "#ffaa00"
            payload = {
                "text": f"{title}\n{message}",
                "attachments": [{"text": json.dumps(details, indent=2), "color": color}],
            }
            async with httpx.AsyncClient(timeout=10) as client:
                (await client.post(url, json=payload)).raise_for_status()
            await self._log_notif(event_id, channel, "sent")

        elif channel == "pagerduty":
            if not cfg.get("notify_pagerduty_enabled"):
                await self._log_notif(event_id, channel, "skipped", "disabled"); return
            key = cfg.get("notify_pagerduty_integration_key", "")
            if not key:
                await self._log_notif(event_id, channel, "skipped", "no integration key"); return
            payload = {
                "routing_key": key,
                "event_action": "trigger",
                "dedup_key": f"pktsnmp-rule{rule['id']}-event{event_id}",
                "payload": {
                    "summary": message,
                    "severity": rule["severity"] if rule["severity"] in ("critical","warning","info") else "warning",
                    "source": "pktSNMP",
                    "custom_details": details,
                },
            }
            async with httpx.AsyncClient(timeout=10) as client:
                (await client.post("https://events.pagerduty.com/v2/enqueue", json=payload)).raise_for_status()
            await self._log_notif(event_id, channel, "sent")

        elif channel == "email":
            if not cfg.get("notify_email_enabled"):
                await self._log_notif(event_id, channel, "skipped", "disabled"); return
            await self._send_email(event_id, rule, title, message, details, cfg)

        elif channel == "webhook":
            if not cfg.get("notify_webhook_enabled"):
                await self._log_notif(event_id, channel, "skipped", "disabled"); return
            url = cfg.get("notify_webhook_url", "")
            if not url:
                await self._log_notif(event_id, channel, "skipped", "no URL"); return
            method = str(cfg.get("notify_webhook_method", "POST")).upper()
            headers = cfg.get("notify_webhook_headers") or {}
            body = {
                "event_id": event_id, "rule_name": rule["name"],
                "rule_type": rule["rule_type"], "severity": rule["severity"],
                "message": message, "details": details,
                "fired_at": datetime.now(tz=timezone.utc).isoformat(),
            }
            async with httpx.AsyncClient(timeout=10) as client:
                (await client.request(method, url, json=body, headers=headers)).raise_for_status()
            await self._log_notif(event_id, channel, "sent")

        elif channel == "tracecat":
            if not cfg.get("notify_tracecat_enabled"):
                await self._log_notif(event_id, channel, "skipped", "disabled"); return
            url = cfg.get("notify_tracecat_webhook_url", "")
            if not url:
                await self._log_notif(event_id, channel, "skipped", "no webhook URL"); return
            body = {
                "event_id": event_id, "rule_name": rule["name"],
                "severity": rule["severity"], "message": message, "details": details,
            }
            async with httpx.AsyncClient(timeout=10) as client:
                (await client.post(url, json=body)).raise_for_status()
            await self._log_notif(event_id, channel, "sent")

        else:
            await self._log_notif(event_id, channel, "skipped", "unknown channel")

    async def _send_email(
        self, event_id: int, rule: dict, subject: str,
        message: str, details: dict, cfg: dict,
    ) -> None:
        import aiosmtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        smtp_host = cfg.get("notify_email_smtp_host", "")
        smtp_port = int(cfg.get("notify_email_smtp_port", 587))
        use_tls   = bool(cfg.get("notify_email_smtp_tls", True))
        username  = cfg.get("notify_email_username", "")
        password  = cfg.get("notify_email_password", "")
        from_addr = cfg.get("notify_email_from", "") or username
        to_addrs  = cfg.get("notify_email_default_to", []) or []

        if not smtp_host or not to_addrs:
            await self._log_notif(event_id, "email", "skipped", "missing smtp_host or recipients")
            return

        body_text = f"{message}\n\nDetails:\n{json.dumps(details, indent=2)}"
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = from_addr
        msg["To"]      = ", ".join(to_addrs)
        msg.attach(MIMEText(body_text, "plain"))

        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=username or None,
            password=password or None,
            start_tls=use_tls,
        )
        await self._log_notif(event_id, "email", "sent")

    async def _log_notif(
        self, event_id: int, channel: str, status: str, error: str | None = None
    ) -> None:
        try:
            async with aiosqlite.connect(self._db_path) as db:
                await db.execute(
                    "INSERT INTO notification_log (event_id, channel, status, error) VALUES (?,?,?,?)",
                    (event_id, channel, status, error),
                )
                await db.commit()
        except Exception as e:
            log.debug(f"Failed to write notification_log: {e}")
