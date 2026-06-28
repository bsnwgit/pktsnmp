"""
Storage backend factory — initializes and provides the active storage instance.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.config import get_settings
from app.storage.base import StorageBase

log = logging.getLogger("pktsnmp.storage.factory")

_storage: Optional[StorageBase] = None


async def init_storage() -> None:
    """Called at application startup to initialize the configured backend."""
    global _storage
    cfg = get_settings()

    # Read backend from settings table (may not exist yet on first run — default to sqlite)
    backend = "sqlite"
    try:
        import json
        import aiosqlite
        async with aiosqlite.connect(cfg.db_path) as db:
            async with db.execute("SELECT value FROM settings WHERE key='storage_backend'") as cur:
                row = await cur.fetchone()
                if row:
                    backend = json.loads(row[0])
    except Exception:
        pass

    if backend == "clickhouse":
        from app.storage.clickhouse import ClickHouseStorage
        _storage = ClickHouseStorage(
            host=cfg.clickhouse_host,
            port=cfg.clickhouse_port,
            database=cfg.clickhouse_database,
            user=cfg.clickhouse_user,
            password=cfg.clickhouse_password,
        )
    elif backend == "duckdb":
        from app.storage.duckdb import DuckDBStorage
        _storage = DuckDBStorage(db_path=str(cfg.duckdb_path))
    else:
        # Default: SQLite time-series (snmp_timeseries.db alongside pktsnmp.db)
        from pathlib import Path
        from app.storage.sqlite_ts import SQLiteStorage
        ts_path = str(Path(cfg.db_path).parent / "snmp_timeseries.db")
        _storage = SQLiteStorage(db_path=ts_path)

    try:
        await _storage.connect()
        log.info(f"Storage backend initialized: {backend}")
    except Exception as e:
        log.error(f"Storage backend failed to connect ({backend}): {e}")
        raise


async def close_storage() -> None:
    """Called at application shutdown."""
    global _storage
    if _storage:
        try:
            await _storage.close()
        except Exception as e:
            log.warning(f"Error closing storage: {e}")
        _storage = None


def get_storage() -> StorageBase:
    """Return the active storage instance (raises if not initialized)."""
    if _storage is None:
        raise RuntimeError("Storage not initialized — call init_storage() at startup")
    return _storage
