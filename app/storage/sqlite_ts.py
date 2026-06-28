"""
SQLite time-series storage backend for pktSNMP.

Uses a dedicated snmp_timeseries.db file (separate from the control-plane pktsnmp.db).
Fully async via aiosqlite — no thread-pool gymnastics, no DuckDB fatal-state surprises.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import aiosqlite

from app.storage.base import StorageBase

log = logging.getLogger("pktsnmp.storage.sqlite_ts")


class SQLiteStorage(StorageBase):
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._init_schema()
        log.info(f"SQLite time-series storage connected: {self.db_path}")

    async def _init_schema(self) -> None:
        await self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS snmp_traps (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at  TEXT NOT NULL DEFAULT (datetime('now')),
                collector_id INTEGER,
                source_ip    TEXT,
                snmp_version TEXT,
                community    TEXT,
                trap_oid     TEXT,
                varbinds     TEXT,
                device_id    INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_traps_received_at ON snmp_traps (received_at);
            CREATE INDEX IF NOT EXISTS idx_traps_source_ip   ON snmp_traps (source_ip);

            CREATE TABLE IF NOT EXISTS snmp_poll_results (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                polled_at        TEXT NOT NULL DEFAULT (datetime('now')),
                collector_id     INTEGER,
                device_id        INTEGER,
                device_ip        TEXT,
                oid              TEXT,
                oid_label        TEXT,
                value            TEXT,
                value_numeric    REAL,
                value_type       TEXT,
                poll_duration_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_poll_polled_at  ON snmp_poll_results (polled_at);
            CREATE INDEX IF NOT EXISTS idx_poll_device_oid ON snmp_poll_results (device_id, oid_label, polled_at);
        """)
        await self._conn.commit()
        log.debug("SQLite time-series schema initialized")

    async def close(self) -> None:
        if self._conn:
            try:
                await self._conn.close()
            except Exception:
                pass
            self._conn = None
        log.info("SQLite time-series connection closed")

    def health_check(self) -> dict:
        if self._conn is None:
            return {"ok": False, "message": "SQLite not connected"}
        return {"ok": True, "message": f"SQLite open: {self.db_path}"}

    # ── Ingest ────────────────────────────────────────────────────────────────

    async def ingest_trap(self, trap: dict) -> None:
        received_at = trap.get("received_at") or datetime.now(tz=timezone.utc).isoformat()
        await self._conn.execute(
            """INSERT INTO snmp_traps
               (received_at, collector_id, source_ip, snmp_version, community, trap_oid, varbinds, device_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                received_at,
                trap.get("collector_id"),
                trap.get("source_ip"),
                trap.get("snmp_version"),
                trap.get("community"),
                trap.get("trap_oid"),
                json.dumps(trap.get("varbinds", [])),
                trap.get("device_id"),
            ),
        )
        await self._conn.commit()

    async def ingest_poll_result(self, result: dict) -> None:
        await self.ingest_poll_results_bulk([result])

    async def ingest_poll_results_bulk(self, results: list[dict]) -> None:
        if not results:
            return
        now = datetime.now(tz=timezone.utc).isoformat()
        rows = []
        for r in results:
            polled_at = r.get("timestamp") or r.get("polled_at") or now
            # Coerce value_numeric safely — OTLP may send strings or ints
            vn = r.get("value_numeric")
            try:
                value_numeric = float(vn) if vn is not None else None
            except (TypeError, ValueError):
                value_numeric = None
            rows.append((
                polled_at,
                r.get("collector_id"),
                r.get("device_id"),
                r.get("device_ip"),
                r.get("oid"),
                r.get("oid_label"),
                r.get("value"),
                value_numeric,
                r.get("value_type"),
                r.get("poll_duration_ms"),
            ))
        await self._conn.executemany(
            """INSERT INTO snmp_poll_results
               (polled_at, collector_id, device_id, device_ip, oid, oid_label, value,
                value_numeric, value_type, poll_duration_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        await self._conn.commit()

    # ── Queries ───────────────────────────────────────────────────────────────

    async def query_traps(
        self,
        collector_id: int | None = None,
        device_ip: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        conditions: list[str] = []
        params: list = []
        if collector_id is not None:
            conditions.append("collector_id = ?")
            params.append(collector_id)
        if device_ip:
            conditions.append("source_ip = ?")
            params.append(device_ip)
        if since:
            conditions.append("received_at >= ?")
            params.append(since)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)

        async with self._conn.execute(
            f"""SELECT id, received_at, collector_id, source_ip, snmp_version,
                       community, trap_oid, varbinds, device_id
                FROM snmp_traps {where}
                ORDER BY received_at DESC LIMIT ?""",
            params,
        ) as cur:
            rows = await cur.fetchall()

        result = []
        for row in rows:
            d = dict(row)
            if isinstance(d.get("varbinds"), str):
                try:
                    d["varbinds"] = json.loads(d["varbinds"])
                except Exception:
                    pass
            result.append(d)
        return result

    async def query_poll_history(
        self,
        device_id: int | None = None,
        oid_label: str | None = None,
        since: str | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        conditions: list[str] = []
        params: list = []
        if device_id is not None:
            conditions.append("device_id = ?")
            params.append(device_id)
        if oid_label:
            conditions.append("oid_label = ?")
            params.append(oid_label)
        if since:
            conditions.append("polled_at >= ?")
            params.append(since)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)

        async with self._conn.execute(
            f"""SELECT id, polled_at, collector_id, device_id, device_ip,
                       oid, oid_label, value, value_numeric, value_type, poll_duration_ms
                FROM snmp_poll_results {where}
                ORDER BY polled_at DESC LIMIT ?""",
            params,
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_device_latest(self, device_id: int) -> list[dict]:
        async with self._conn.execute(
            """SELECT oid_label, value, value_numeric, value_type, polled_at
               FROM snmp_poll_results
               WHERE device_id = ?
                 AND polled_at = (
                     SELECT MAX(polled_at) FROM snmp_poll_results r2
                     WHERE r2.device_id = snmp_poll_results.device_id
                       AND r2.oid_label = snmp_poll_results.oid_label
                 )
               ORDER BY oid_label""",
            [device_id],
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    # ── Cleanup ───────────────────────────────────────────────────────────────

    async def run_cleanup(self, retention_days: int) -> dict:
        cutoff = f"-{retention_days} days"
        async with self._conn.execute(
            "DELETE FROM snmp_traps WHERE received_at < datetime('now', ?)", (cutoff,)
        ) as cur:
            trap_count = cur.rowcount
        async with self._conn.execute(
            "DELETE FROM snmp_poll_results WHERE polled_at < datetime('now', ?)", (cutoff,)
        ) as cur:
            poll_count = cur.rowcount
        await self._conn.commit()
        log.info(f"Cleanup: {trap_count} traps, {poll_count} poll results deleted (retention={retention_days}d)")
        return {
            "snmp_data_eligible": trap_count + poll_count,
            "deleted_traps": trap_count,
            "deleted_poll_results": poll_count,
        }
