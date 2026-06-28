import pathlib

BASE = pathlib.Path("/sessions/determined-bold-wright/mnt/pktSNMP")

# ── duckdb.py completion ──────────────────────────────────────────────────────
# File is truncated at line 80 (inside close() method)
DUCKDB_SUFFIX = '''            except Exception:
                pass
        self._conn = None
        log.info("DuckDB connection closed")

    def health_check(self) -> dict:
        try:
            self._conn.execute("SELECT 1").fetchone()
            return {"ok": True, "message": f"DuckDB open: {self.db_path}"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    # -- Ingest ----------------------------------------------------------------

    async def ingest_trap(self, trap: dict) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._insert_trap, trap)

    def _insert_trap(self, trap: dict) -> None:
        self._conn.execute(
            """
            INSERT INTO snmp_traps
                (collector_id, source_ip, snmp_version, community, trap_oid, varbinds, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                trap.get("collector_id"),
                trap.get("source_ip"),
                trap.get("snmp_version"),
                trap.get("community"),
                trap.get("trap_oid"),
                json.dumps(trap.get("varbinds", [])),
                trap.get("device_id"),
            ),
        )

    async def ingest_poll_result(self, result: dict) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._insert_poll_result, result)

    def _insert_poll_result(self, result: dict) -> None:
        self._conn.execute(
            """
            INSERT INTO snmp_poll_results
                (collector_id, device_id, device_ip, oid, oid_label, value,
                 value_numeric, value_type, poll_duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                result.get("collector_id"),
                result.get("device_id"),
                result.get("device_ip"),
                result.get("oid"),
                result.get("oid_label"),
                result.get("value"),
                result.get("value_numeric"),
                result.get("value_type"),
                result.get("poll_duration_ms"),
            ),
        )

    # -- Queries ---------------------------------------------------------------

    async def query_traps(
        self,
        collector_id: int | None = None,
        device_ip: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        async with self._lock:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None, self._query_traps_sync, collector_id, device_ip, since, limit
            )

    def _query_traps_sync(
        self,
        collector_id: int | None,
        device_ip: str | None,
        since: str | None,
        limit: int,
    ) -> list[dict]:
        from typing import Any
        conditions: list[str] = []
        params: list[Any] = []

        if collector_id is not None:
            conditions.append("collector_id = ?")
            params.append(collector_id)
        if device_ip:
            conditions.append("source_ip = ?")
            params.append(device_ip)
        if since:
            conditions.append("received_at >= ?::TIMESTAMPTZ")
            params.append(since)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)

        sql = f"""
            SELECT id, received_at, collector_id, source_ip, snmp_version,
                   community, trap_oid, varbinds, device_id
            FROM snmp_traps
            {where}
            ORDER BY received_at DESC
            LIMIT ?
        """
        rows = self._conn.execute(sql, params).fetchall()
        cols = [
            "id", "received_at", "collector_id", "source_ip", "snmp_version",
            "community", "trap_oid", "varbinds", "device_id",
        ]
        result = []
        for row in rows:
            d = dict(zip(cols, row))
            if isinstance(d.get("varbinds"), str):
                try:
                    d["varbinds"] = json.loads(d["varbinds"])
                except Exception:
                    pass
            if hasattr(d.get("received_at"), "isoformat"):
                d["received_at"] = d["received_at"].isoformat()
            result.append(d)
        return result

    async def query_poll_history(
        self,
        device_id: int | None = None,
        oid_label: str | None = None,
        since: str | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        async with self._lock:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None, self._query_poll_history_sync, device_id, oid_label, since, limit
            )

    def _query_poll_history_sync(
        self,
        device_id: int | None,
        oid_label: str | None,
        since: str | None,
        limit: int,
    ) -> list[dict]:
        from typing import Any
        conditions: list[str] = []
        params: list[Any] = []

        if device_id is not None:
            conditions.append("device_id = ?")
            params.append(device_id)
        if oid_label:
            conditions.append("oid_label = ?")
            params.append(oid_label)
        if since:
            conditions.append("polled_at >= ?::TIMESTAMPTZ")
            params.append(since)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)

        sql = f"""
            SELECT id, polled_at, collector_id, device_id, device_ip,
                   oid, oid_label, value, value_numeric, value_type, poll_duration_ms
            FROM snmp_poll_results
            {where}
            ORDER BY polled_at DESC
            LIMIT ?
        """
        rows = self._conn.execute(sql, params).fetchall()
        cols = [
            "id", "polled_at", "collector_id", "device_id", "device_ip",
            "oid", "oid_label", "value", "value_numeric", "value_type", "poll_duration_ms",
        ]
        result = []
        for row in rows:
            d = dict(zip(cols, row))
            if hasattr(d.get("polled_at"), "isoformat"):
                d["polled_at"] = d["polled_at"].isoformat()
            result.append(d)
        return result

    async def get_device_latest(self, device_id: int) -> list[dict]:
        """Get the most recent value per oid_label for a device."""
        async with self._lock:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, self._get_device_latest_sync, device_id)

    def _get_device_latest_sync(self, device_id: int) -> list[dict]:
        sql = """
            SELECT oid_label, value, value_numeric, value_type, polled_at
            FROM snmp_poll_results
            WHERE device_id = ?
              AND polled_at = (
                  SELECT MAX(polled_at)
                  FROM snmp_poll_results r2
                  WHERE r2.device_id = snmp_poll_results.device_id
                    AND r2.oid_label = snmp_poll_results.oid_label
              )
            ORDER BY oid_label
        """
        rows = self._conn.execute(sql, [device_id]).fetchall()
        cols = ["oid_label", "value", "value_numeric", "value_type", "polled_at"]
        result = []
        for row in rows:
            d = dict(zip(cols, row))
            if hasattr(d.get("polled_at"), "isoformat"):
                d["polled_at"] = d["polled_at"].isoformat()
            result.append(d)
        return result

    # -- Cleanup ---------------------------------------------------------------

    async def run_cleanup(self, retention_days: int) -> dict:
        async with self._lock:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, self._run_cleanup_sync, retention_days)

    def _run_cleanup_sync(self, retention_days: int) -> dict:
        trap_result = self._conn.execute(
            "DELETE FROM snmp_traps WHERE received_at < now() - INTERVAL ? DAY RETURNING id",
            [retention_days],
        ).fetchall()
        poll_result = self._conn.execute(
            "DELETE FROM snmp_poll_results WHERE polled_at < now() - INTERVAL ? DAY RETURNING id",
            [retention_days],
        ).fetchall()
        deleted_traps = len(trap_result)
        deleted_poll = len(poll_result)
        log.info(
            f"Cleanup complete: {deleted_traps} traps, {deleted_poll} poll results deleted "
            f"(retention={retention_days} days)"
        )
        return {
            "snmp_data_eligible": deleted_traps + deleted_poll,
            "deleted_traps": deleted_traps,
            "deleted_poll_results": deleted_poll,
        }
'''

duckdb_path = BASE / "app/storage/duckdb.py"
current = duckdb_path.read_text(encoding='utf-8', errors='replace')
# File is truncated at "ex" (line 80), fix that line then append
# Truncated at: "await loop.run_in_executor(None, self._conn.close)\n            ex"
fixed = current.rstrip().rstrip('ex').rstrip().rstrip()
# Remove the trailing "ex" characters
if fixed.endswith('            ex'):
    fixed = fixed[:-14]
elif fixed.endswith('ex'):
    fixed = fixed[:-2]
duckdb_path.write_text(fixed + DUCKDB_SUFFIX, encoding='utf-8')
print(f"duckdb.py: {len((fixed + DUCKDB_SUFFIX).splitlines())} lines")

