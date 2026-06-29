"""
SQLite time-series storage backend for pktSNMP.

Uses a dedicated snmp_timeseries.db file (separate from the control-plane pktsnmp.db).
Fully async via aiosqlite — no thread-pool gymnastics, no DuckDB fatal-state surprises.

Performance notes
-----------------
* snmp_latest — a materialized "last known value" table keyed by
  (device_id, oid_label, interface_label).  Every bulk insert upserts into it so
  get_all_devices_latest() is O(n_devices) instead of O(4M rows) — drops overview
  load from ~9 s to <50 ms.

* Datetime format — stored timestamps use ISO-8601 with a 'T' separator
  (e.g. 2026-06-29T14:23:31+00:00).  SQLite's datetime('now') returns a space-
  separated string (2026-06-29 14:23:31) which is always LESS THAN any T-format
  string in a lexicographic comparison, so time-bounded WHERE clauses broke
  silently (all rows appeared "current" and retention never deleted anything).
  All date math now uses strftime('%Y-%m-%dT%H:%M:%S', 'now', ...) which produces
  a T-format string compatible with stored values.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone, timedelta

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
                poll_duration_ms INTEGER,
                interface_label  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_poll_polled_at  ON snmp_poll_results (polled_at);
            CREATE INDEX IF NOT EXISTS idx_poll_device_oid ON snmp_poll_results (device_id, oid_label, polled_at);

            -- Materialized "latest value" table — O(1) lookups for the overview.
            -- PRIMARY KEY enforces uniqueness; INSERT OR REPLACE keeps it current.
            CREATE TABLE IF NOT EXISTS snmp_latest (
                device_id       INTEGER NOT NULL,
                oid_label       TEXT    NOT NULL,
                interface_label TEXT    NOT NULL DEFAULT '',
                value           TEXT,
                value_numeric   REAL,
                value_type      TEXT,
                polled_at       TEXT,
                PRIMARY KEY (device_id, oid_label, interface_label)
            );
            CREATE INDEX IF NOT EXISTS idx_latest_device ON snmp_latest (device_id);
        """)

        # Idempotent column migration: add interface_label to snmp_poll_results
        try:
            await self._conn.execute(
                "ALTER TABLE snmp_poll_results ADD COLUMN interface_label TEXT"
            )
            await self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_poll_device_iface ON snmp_poll_results "
                "(device_id, interface_label, oid_label, polled_at)"
            )
            await self._conn.commit()
            log.info("Migrated snmp_poll_results: added interface_label column")
        except Exception:
            pass  # already exists

        # One-time backfill of snmp_latest from existing poll data.
        # Runs only if the table is empty (i.e. first start after this migration).
        # Takes ~9 s on a 4.4 M-row DB but only runs once ever.
        try:
            row = await (await self._conn.execute(
                "SELECT COUNT(*) FROM snmp_latest"
            )).fetchone()
            if row and row[0] == 0:
                log.info("snmp_latest is empty — backfilling from snmp_poll_results (one-time, may take ~10 s)…")
                await self._conn.execute("""
                    INSERT OR REPLACE INTO snmp_latest
                        (device_id, oid_label, interface_label,
                         value, value_numeric, value_type, polled_at)
                    SELECT device_id,
                           oid_label,
                           COALESCE(interface_label, '') AS interface_label,
                           value, value_numeric, value_type, polled_at
                    FROM (
                        SELECT device_id, oid_label, interface_label,
                               value, value_numeric, value_type, polled_at,
                               ROW_NUMBER() OVER (
                                   PARTITION BY device_id, oid_label,
                                                COALESCE(interface_label, '')
                                   ORDER BY polled_at DESC
                               ) AS rn
                        FROM snmp_poll_results
                        WHERE device_id IS NOT NULL
                    )
                    WHERE rn = 1
                """)
                await self._conn.commit()
                count = (await (await self._conn.execute(
                    "SELECT COUNT(*) FROM snmp_latest"
                )).fetchone())[0]
                log.info(f"snmp_latest backfill complete: {count:,} rows")
        except Exception as exc:
            log.warning(f"snmp_latest backfill skipped: {exc}")

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
        latest_rows = []   # for snmp_latest upsert
        for r in results:
            polled_at = r.get("timestamp") or r.get("polled_at") or now
            vn = r.get("value_numeric")
            try:
                value_numeric = float(vn) if vn is not None else None
            except (TypeError, ValueError):
                value_numeric = None
            iface = r.get("interface_label") or ""
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
                iface if iface else None,   # keep NULL in poll_results for existing queries
            ))
            # Only maintain snmp_latest for registered devices
            if r.get("device_id") is not None and r.get("oid_label"):
                latest_rows.append((
                    r["device_id"],
                    r["oid_label"],
                    iface,
                    r.get("value"),
                    value_numeric,
                    r.get("value_type"),
                    polled_at,
                ))

        await self._conn.executemany(
            """INSERT INTO snmp_poll_results
               (polled_at, collector_id, device_id, device_ip, oid, oid_label, value,
                value_numeric, value_type, poll_duration_ms, interface_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )

        # Upsert latest values — keep only the newest per (device, oid, interface).
        # We sort by polled_at ascending so later timestamps win on INSERT OR REPLACE.
        if latest_rows:
            latest_rows.sort(key=lambda x: x[6])   # sort by polled_at
            await self._conn.executemany(
                """INSERT OR REPLACE INTO snmp_latest
                   (device_id, oid_label, interface_label,
                    value, value_numeric, value_type, polled_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                latest_rows,
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
               FROM snmp_latest
               WHERE device_id = ?
               ORDER BY oid_label""",
            [device_id],
        ) as cur:
            rows = await cur.fetchall()
        # Fall back to the slow correlated query if snmp_latest has nothing for this device
        if not rows:
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

    async def get_device_latest_by_ip(self, device_ip: str) -> list[dict]:
        """Fallback for devices not yet registered (device_id = NULL)."""
        async with self._conn.execute(
            """SELECT oid_label, value, value_numeric, value_type, polled_at
               FROM snmp_poll_results
               WHERE device_ip = ?
                 AND polled_at = (
                     SELECT MAX(polled_at) FROM snmp_poll_results r2
                     WHERE r2.device_ip = snmp_poll_results.device_ip
                       AND r2.oid_label = snmp_poll_results.oid_label
                 )
               ORDER BY oid_label""",
            [device_ip],
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def query_poll_history_bucketed(
        self,
        device_id: int | None = None,
        device_ip: str | None = None,
        oid_labels: list[str] | None = None,
        since_iso: str | None = None,
        until_iso: str | None = None,
        bucket_seconds: int = 0,
        limit: int = 2000,
        if_index: int | None = None,       # kept for API compat, ignored (oid is NULL)
        interface_label: str | None = None, # preferred: filter by interface name
    ) -> list[dict]:
        """Query poll history with optional server-side time bucketing.

        bucket_seconds=0  → raw rows (≤1h views)
        bucket_seconds=300  → 5-min averages (6h view)
        bucket_seconds=900  → 15-min averages (24h view)
        bucket_seconds=3600 → 1-hour averages (7d / custom long view)

        Returns rows with: bucket_ts, oid_label, avg_value, max_value, min_value,
        count (samples per bucket). Frontend uses max_value for rate computation
        (cumulative counter at end-of-bucket) and avg_value for gauge/status metrics.
        """
        conditions: list[str] = []
        params: list = []

        if device_id is not None:
            conditions.append("device_id = ?")
            params.append(device_id)
        elif device_ip is not None:
            conditions.append("device_ip = ?")
            params.append(device_ip)

        if oid_labels:
            placeholders = ",".join("?" * len(oid_labels))
            conditions.append(f"oid_label IN ({placeholders})")
            params.extend(oid_labels)

        if interface_label is not None:
            conditions.append("interface_label = ?")
            params.append(interface_label)

        if since_iso:
            conditions.append("polled_at >= ?")
            params.append(since_iso)
        if until_iso:
            conditions.append("polled_at <= ?")
            params.append(until_iso)

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        if bucket_seconds and bucket_seconds > 0:
            params.append(bucket_seconds)
            params.append(bucket_seconds)
            params.append(limit)
            sql = f"""
                SELECT
                    datetime(
                        (CAST(strftime('%s', polled_at) AS INTEGER) / ?) * ?,
                        'unixepoch'
                    ) AS bucket_ts,
                    oid_label,
                    AVG(value_numeric)  AS avg_value,
                    MAX(value_numeric)  AS max_value,
                    MIN(value_numeric)  AS min_value,
                    COUNT(*)            AS sample_count
                FROM snmp_poll_results
                {where}
                GROUP BY bucket_ts, oid_label
                ORDER BY bucket_ts ASC, oid_label ASC
                LIMIT ?
            """
        else:
            params.append(limit)
            sql = f"""
                SELECT
                    polled_at            AS bucket_ts,
                    oid_label,
                    value_numeric        AS avg_value,
                    value_numeric        AS max_value,
                    value_numeric        AS min_value,
                    1                    AS sample_count
                FROM snmp_poll_results
                {where}
                ORDER BY polled_at ASC, oid_label ASC
                LIMIT ?
            """

        async with self._conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_ingest_rate(
        self,
        collector_id: int | None = None,
        hours: int = 1,
        bucket_minutes: int = 5,
    ) -> list[dict]:
        """Return polls-per-minute bucketed over the last N hours.
        Used for the Collectors page sparkline and poll_rate_low alert evaluation.
        """
        bucket_seconds = bucket_minutes * 60
        # Use strftime T-format to match stored timestamps (stored with 'T' separator)
        conditions = [f"polled_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-{hours} hours')"]
        params: list = []
        if collector_id is not None:
            conditions.append("collector_id = ?")
            params.append(collector_id)
        where = "WHERE " + " AND ".join(conditions)
        params += [bucket_seconds, bucket_seconds]

        sql = f"""
            SELECT
                datetime(
                    (CAST(strftime('%s', polled_at) AS INTEGER) / ?) * ?,
                    'unixepoch'
                ) AS bucket_ts,
                COUNT(*) AS poll_count,
                COUNT(DISTINCT device_id) AS active_devices
            FROM snmp_poll_results
            {where}
            GROUP BY bucket_ts
            ORDER BY bucket_ts ASC
        """
        async with self._conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def query_trap_events(
        self,
        device_id: int | None = None,
        device_ip: str | None = None,
        since_iso: str | None = None,
        until_iso: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Trap events for timeline overlay on the Metrics page."""
        conditions: list[str] = []
        params: list = []
        if device_id is not None:
            conditions.append("device_id = ?")
            params.append(device_id)
        elif device_ip is not None:
            conditions.append("source_ip = ?")
            params.append(device_ip)
        if since_iso:
            conditions.append("received_at >= ?")
            params.append(since_iso)
        if until_iso:
            conditions.append("received_at <= ?")
            params.append(until_iso)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)
        async with self._conn.execute(
            f"""SELECT id, received_at, trap_oid, source_ip, device_id
                FROM snmp_traps {where}
                ORDER BY received_at ASC LIMIT ?""",
            params,
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_metric_in_window(
        self,
        device_id: int | None,
        device_ip: str | None,
        oid_label: str,
        window_min: int,
    ) -> list[dict]:
        """Return recent raw rows for a device+OID within a time window.
        Used by the alert engine evaluators.
        """
        # Use strftime T-format so the comparison works against stored ISO timestamps
        conditions = [
            "oid_label = ?",
            f"polled_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-{window_min} minutes')",
        ]
        params: list = [oid_label]
        if device_id is not None:
            conditions.append("device_id = ?")
            params.append(device_id)
        elif device_ip is not None:
            conditions.append("device_ip = ?")
            params.append(device_ip)
        where = "WHERE " + " AND ".join(conditions)
        async with self._conn.execute(
            f"""SELECT polled_at, value_numeric
                FROM snmp_poll_results {where}
                ORDER BY polled_at ASC""",
            params,
        ) as cur:
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def get_poll_gaps(
        self,
        collector_id: int,
        silence_minutes: int,
    ) -> bool:
        """Return True if no polls have arrived from collector_id in silence_minutes."""
        async with self._conn.execute(
            """SELECT MAX(polled_at) AS last_poll
               FROM snmp_poll_results
               WHERE collector_id = ?""",
            [collector_id],
        ) as cur:
            row = await cur.fetchone()
        if not row or not row["last_poll"]:
            return True
        async with self._conn.execute(
            "SELECT (julianday('now') - julianday(?)) * 1440.0 AS minutes_ago",
            [row["last_poll"]],
        ) as cur:
            gap_row = await cur.fetchone()
        minutes_ago = gap_row["minutes_ago"] if gap_row else 9999
        return minutes_ago >= silence_minutes

    async def get_device_last_poll(self, device_id: int | None, device_ip: str | None) -> str | None:
        """Return the most recent polled_at for a device (for device_unreachable check)."""
        if device_id is not None:
            condition, param = "device_id = ?", device_id
        elif device_ip is not None:
            condition, param = "device_ip = ?", device_ip
        else:
            return None
        async with self._conn.execute(
            f"SELECT MAX(polled_at) AS last_poll FROM snmp_poll_results WHERE {condition}",
            [param],
        ) as cur:
            row = await cur.fetchone()
        return row["last_poll"] if row else None

    async def get_device_interfaces(self, device_id: int) -> list[dict]:
        """Return the interface list for a device using interface_label.

        otelcol attaches ifDescr/ifType/ifName as datapoint attributes.
        The parser stores ifDescr (fallback ifName) in the interface_label column.
        We GROUP BY interface_label and grab the latest status / speed for each.
        """
        IF_OID_LABELS = (
            "ifOperStatusMetric", "ifAdminStatusMetric", "ifSpeedMetric",
            "ifOperStatus", "ifAdminStatus", "ifSpeed",
            "ifType", "ifPhysAddress",
            "ifInOctets", "ifOutOctets",
        )
        placeholders = ",".join("?" * len(IF_OID_LABELS))

        # Use snmp_latest for efficiency — same data, no full-table scan
        async with self._conn.execute(
            f"""
            SELECT interface_label, oid_label, value, value_numeric
            FROM snmp_latest
            WHERE device_id = ?
              AND interface_label IS NOT NULL
              AND interface_label != ''
              AND oid_label IN ({placeholders})
            ORDER BY interface_label, oid_label
            """,
            [device_id, *IF_OID_LABELS],
        ) as cur:
            rows = await cur.fetchall()

        # Fall back to slow correlated query if snmp_latest has nothing
        if not rows:
            async with self._conn.execute(
                f"""
                WITH ranked AS (
                    SELECT interface_label, oid_label, value, value_numeric,
                           ROW_NUMBER() OVER (
                               PARTITION BY interface_label, oid_label
                               ORDER BY polled_at DESC
                           ) AS rn
                    FROM snmp_poll_results
                    WHERE device_id = ?
                      AND interface_label IS NOT NULL
                      AND oid_label IN ({placeholders})
                )
                SELECT interface_label, oid_label, value, value_numeric
                FROM ranked
                WHERE rn = 1
                ORDER BY interface_label, oid_label
                """,
                [device_id, *IF_OID_LABELS],
            ) as cur:
                rows = await cur.fetchall()

        interfaces: dict[str, dict] = {}
        for row in rows:
            iface_label = row["interface_label"]
            if not iface_label:
                continue
            iface = interfaces.setdefault(iface_label, {"interface_label": iface_label})
            label  = row["oid_label"]
            val    = row["value"]
            valnum = row["value_numeric"]

            if label in ("ifOperStatus", "ifOperStatusMetric"):
                if valnum is not None:
                    iface["oper_status"] = "up" if int(valnum) == 1 else "down"
                elif val:
                    iface["oper_status"] = val.lower()
            elif label in ("ifAdminStatus", "ifAdminStatusMetric"):
                if valnum is not None:
                    iface["admin_status"] = "up" if int(valnum) == 1 else "down"
                elif val:
                    iface["admin_status"] = val.lower()
            elif label in ("ifSpeed", "ifSpeedMetric"):
                if valnum:
                    iface["speed_mbps"] = valnum / 1_000_000
            elif label == "ifType":
                iface["if_type"] = val
            elif label == "ifPhysAddress":
                iface["mac"] = val

        result = []
        for iface_label in sorted(interfaces):
            iface = interfaces[iface_label]
            result.append({
                "interface_label": iface_label,
                "name":            iface_label,
                "oper_status":     iface.get("oper_status", "unknown"),
                "admin_status":    iface.get("admin_status", "unknown"),
                "speed_mbps":      iface.get("speed_mbps"),
                "if_type":         iface.get("if_type"),
                "mac":             iface.get("mac"),
            })
        return result

    async def get_all_devices_latest(self, device_ids: list[int]) -> dict[int, list[dict]]:
        """Batch-load the latest metric snapshot for multiple devices.

        Returns { device_id: [MetricLatestItem, ...] } using the snmp_latest
        materialized table — O(n_devices) instead of a 9-second window function
        over 4+ million rows.
        """
        if not device_ids:
            return {}
        placeholders = ",".join("?" * len(device_ids))

        async with self._conn.execute(
            f"""SELECT device_id, oid_label, value, value_numeric, value_type, polled_at
                FROM snmp_latest
                WHERE device_id IN ({placeholders})
                ORDER BY device_id, oid_label""",
            device_ids,
        ) as cur:
            rows = await cur.fetchall()

        result: dict[int, list[dict]] = {did: [] for did in device_ids}
        for row in rows:
            d = dict(row)
            did = d.pop("device_id")
            result[did].append(d)
        return result

    # ── Cleanup ───────────────────────────────────────────────────────────────

    async def run_cleanup(self, retention_days: int) -> dict:
        # Compute cutoff in Python with T-format to match stored timestamps.
        # Using datetime('now', ...) produces a space-format string that compares
        # incorrectly against T-format stored values.
        cutoff = (
            datetime.now(tz=timezone.utc) - timedelta(days=retention_days)
        ).strftime("%Y-%m-%dT%H:%M:%S")

        async with self._conn.execute(
            "DELETE FROM snmp_traps WHERE received_at < ?", (cutoff,)
        ) as cur:
            trap_count = cur.rowcount
        async with self._conn.execute(
            "DELETE FROM snmp_poll_results WHERE polled_at < ?", (cutoff,)
        ) as cur:
            poll_count = cur.rowcount
        await self._conn.commit()
        log.info(f"Cleanup: {trap_count} traps, {poll_count} poll results deleted (retention={retention_days}d)")
        return {
            "snmp_data_eligible": trap_count + poll_count,
            "deleted_traps": trap_count,
            "deleted_poll_results": poll_count,
        }
