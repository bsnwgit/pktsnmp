"""
Local collector -- in-process trap receiver and poll engine for pktSNMP O2.
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


class LocalCollector:
    def __init__(self, alert_engine: "AlertEngine | None" = None) -> None:
        self._alert_engine = alert_engine
        self._trap_receiver: TrapReceiver | None = None
        self._poll_engine: PollEngine | None = None
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

        log.info(
            f"Local collector started -- trap={self._trap_enabled}, poll={self._poll_enabled}"
        )

    async def stop(self) -> None:
        if self._trap_receiver:
            await self._trap_receiver.stop()
        if self._poll_engine:
            await self._poll_engine.stop()
        log.info("Local collector stopped")

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
        try:
            trap = parse_trap_payload(raw_trap)
            storage = get_storage()
            await storage.ingest_trap(trap)
            log.debug(f"Trap from {trap['source_ip']} stored")
            if self._alert_engine:
                await self._alert_engine.process_trap(trap)
        except Exception as e:
            log.error(f"Trap handler error: {e}")

    async def _handle_poll_result(self, result: dict) -> None:
        try:
            storage = get_storage()
            await storage.ingest_poll_result(result)
            if self._alert_engine:
                await self._alert_engine.process_poll_result(result)
        except Exception as e:
            log.error(f"Poll result handler error: {e}")

    async def _handle_poll_failure(self, device_id: int, device_ip: str) -> None:
        if self._alert_engine:
            try:
                await self._alert_engine.process_poll_failure(device_id, device_ip)
            except Exception as e:
                log.debug(f"Poll failure alert error: {e}")
