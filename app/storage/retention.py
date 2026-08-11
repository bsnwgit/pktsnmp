"""
Time-series retention scheduler.

The storage backends have always implemented `run_cleanup(retention_days)`,
and the Settings page has always exposed `retention_days_raw` — but nothing
ever called it. The setting was honoured by no one: poll results accumulated
indefinitely regardless of what the UI said.

This is the missing piece. It runs the backend's own cleanup on a schedule, so
the configured retention actually takes effect.

Notes for whoever touches this next:

* It calls `get_storage()`, so it works for whichever backend is active
  (SQLite, DuckDB, ClickHouse) rather than reimplementing per-backend deletes.
* The first run is deliberately delayed. Startup already does migrations, a
  possible snmp_latest backfill and the first poll sweep; a prune racing that
  would just make a slow boot slower.
* It logs every run including no-op runs. A retention job that silently does
  nothing is exactly the failure this module exists to fix, so "it ran and
  deleted 0 rows" must be distinguishable from "it never ran".
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import aiosqlite

from app.config import get_settings

log = logging.getLogger("pktsnmp.retention")
settings = get_settings()

# Once per day is plenty: retention is expressed in days.
_INTERVAL_SECONDS = 86_400

# Let startup settle before the first prune.
_FIRST_RUN_DELAY_SECONDS = 300

_DEFAULT_RETENTION_DAYS = 90


class StorageRetention:
    _instance: "Optional[StorageRetention]" = None

    def __init__(self, interval_seconds: int = _INTERVAL_SECONDS):
        self._interval = interval_seconds
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        StorageRetention._instance = self
        self._task = asyncio.create_task(self._run_loop())
        log.info(f"Storage retention started (interval={self._interval}s)")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _read_retention_days(self) -> int:
        """Read retention_days_raw from settings, falling back to the default."""
        try:
            async with aiosqlite.connect(settings.db_path) as db:
                async with db.execute(
                    "SELECT value FROM settings WHERE key = 'retention_days_raw'"
                ) as cur:
                    row = await cur.fetchone()
            if not row:
                return _DEFAULT_RETENTION_DAYS
            value = json.loads(row[0])
            days = int(value)
            return days if days > 0 else 0
        except Exception as e:
            log.warning(f"Could not read retention_days_raw ({e}) — using default")
            return _DEFAULT_RETENTION_DAYS

    async def run_once(self) -> dict:
        """Run a single prune. Exposed so it can be triggered and tested directly."""
        days = await self._read_retention_days()
        if days <= 0:
            log.info("Storage retention disabled (retention_days_raw <= 0) — skipping")
            return {"skipped": True, "retention_days": days}

        from app.storage.factory import get_storage
        storage = get_storage()
        if storage is None:
            log.warning("Storage retention: no storage backend available — skipping")
            return {"skipped": True, "reason": "no storage"}

        result = await storage.run_cleanup(days)
        deleted = result.get("snmp_data_eligible", 0)
        log.info(
            f"Storage retention run complete: {deleted} row(s) removed "
            f"(retention={days}d, backend={storage.__class__.__name__})"
        )
        return result

    async def _run_loop(self) -> None:
        await asyncio.sleep(_FIRST_RUN_DELAY_SECONDS)
        while True:
            try:
                await self.run_once()
            except Exception as e:
                log.error(f"Storage retention error: {e}")
            await asyncio.sleep(self._interval)
