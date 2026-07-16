"""
Local collector -- in-process trap receiver and poll engine for pktSNMP.
Devices assigned to collector_id=1 are handled here.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

import aiosqlite

from app.snmp.trap_receiver import TrapReceiver
from app.snmp.poll_engine import PollEngine
from app.snmp.parser import parse_trap_payload
from app.storage.factory import get_storage

if TYPE_CHECKING:
    from app.alerts.engine import AlertEngine

log = logging.getLogger("pktsnmp.snmp.local_collector")

# id of the built-in local collector row seeded by migrations/002_phase2.sql
LOCAL_COLLECTOR_ID = 1
_HEARTBEAT_INTERVAL_SECONDS = 60


class LocalCollector:
    def __init__(self, alert_engine: "AlertEngine | None" = None) -> None:
        self._alert_engine = alert_engine
        self._trap_receiver: TrapReceiver | None = None
        self._poll_engine: PollEngine | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._trap_enabled: bool = False
        self._poll_enabled: bool = False
        self._db_path: str = ""

    async def _get_setting(self, db: aiosqlite.Connection, key: str, default=None):
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
        return json.loads(row[0]) if row else default

    async def start(self, db_path: str) -> None:
        self._db_path = db_path
        async with aiosqlite.connect(db_path) as db:
            self._trap_enabled = await self._get_setting(db, "snmp_trap_enabled", False)
            self._poll_enabled = await self._get_setting(db, "snmp_poll_enabled", False)
            trap_port = await self._get_setting(db, "snmp_trap_port", 162)
            bind_addr = await self._get_setting(db, "snmp_trap_bind_address", "0.0.0.0")

        if self._trap_enabled:
            self._trap_receiver = TrapReceiver(bind_addr, trap_port, self._handle_trap)
            try:
                await self._trap_receiver.start()
            except Exception as e:
                log.error(f"Trap receiver failed to start: {e}")
                self._trap_receiver = None

        if self._poll_enabled:
            self._poll_engine = PollEngine(
                self._handle_poll_result,
                failure_handler=self._handle_poll_failure,
            )
            await self._poll_engine.start(db_path)

        # The `collectors` table's last_seen/status (and the effective_status the UI
        # shows) are otherwise only ever updated by the bearer-token-authenticated
        # OTLP ingest/heartbeat endpoints remote otelcol collectors call over HTTP —
        # the in-process local collector never calls those, so without this it always
        # displays as offline even while actively polling/receiving traps.
        if self._trap_enabled or self._poll_enabled:
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(), name="local_collector_heartbeat"
            )

        log.info(
            f"Local collector started -- trap={self._trap_enabled}, poll={self._poll_enabled}"
        )

    async def stop(self) -> None:
        if self._trap_receiver:
            await self._trap_receiver.stop()
        if self._poll_engine:
            await self._poll_engine.stop()
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        log.info("Local collector stopped")

    async def _heartbeat_loop(self) -> None:
        while True:
            try:
                async with aiosqlite.connect(self._db_path) as db:
                    await db.execute(
                        "UPDATE collectors SET last_seen=datetime('now'), status='online', "
                        "updated_at=datetime('now') WHERE id=?",
                        (LOCAL_COLLECTOR_ID,),
                    )
                    await db.commit()
            except Exception as e:
                log.debug(f"Local collector heartbeat error: {e}")
            await asyncio.sleep(_HEARTBEAT_INTERVAL_SECONDS)

    def signal_reload(self) -> None:
        if self._poll_engine:
            self._poll_engine.signal_reload()

    def get_status(self) -> dict:
        return {
            "trap_enabled": self._trap_enabled,
            "poll_enabled": self._poll_enabled,
            "trap_running": self._trap_receiver is not None,
            "poll_running": self._poll_engine is not None,
        }

    async def _handle_trap(self, raw_trap: dict) -> None:
        # Alert rules (including trap_received) are evaluated independently by
        # AlertEngine's own periodic sweep (app/alerts/engine.py) reading stored
        # data on its own schedule — there's no live event hook to call into here.
        try:
            trap = parse_trap_payload(raw_trap)
            storage = get_storage()
            await storage.ingest_trap(trap)
            log.debug(f"Trap from {trap['source_ip']} stored")
        except Exception as e:
            log.error(f"Trap handler error: {e}")

    async def _handle_poll_result(self, result: dict) -> None:
        try:
            storage = get_storage()
            await storage.ingest_poll_result(result)
        except Exception as e:
            log.error(f"Poll result handler error: {e}")

    async def _handle_poll_failure(self, device_id: int, device_ip: str) -> None:
        # device_down/device_unreachable alerting reads devices.status/last_seen
        # directly in AlertEngine's periodic sweep — poll_engine.py's own
        # _update_device_status() call already keeps those columns current.
        pass
