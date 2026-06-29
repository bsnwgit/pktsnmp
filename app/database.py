"""
SQLite async database engine for the pktSNMP app sidecar DB
(users, settings, alert rules, alert events, notification log).
"""
from __future__ import annotations

import aiosqlite
from pathlib import Path
from typing import AsyncGenerator

from app.config import get_settings

_settings = get_settings()
DB_PATH = _settings.db_path


async def get_db() -> AsyncGenerator[aiosqlite.Connection, None]:
    """FastAPI dependency — yields an open aiosqlite connection per request."""
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        yield conn


async def init_db() -> None:
    """Run migrations on startup. Safe to call multiple times (idempotent SQL)."""
    migration_dir = Path(__file__).parent.parent / "migrations"
    migration_files = sorted(migration_dir.glob("*.sql"))

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS _migrations (
                filename TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        await conn.commit()

        for mfile in migration_files:
            async with conn.execute(
                "SELECT 1 FROM _migrations WHERE filename = ?", (mfile.name,)
            ) as cur:
                already_applied = await cur.fetchone()

            if not already_applied:
                sql = mfile.read_text()
                try:
                    await conn.executescript(sql)
                except Exception as exc:
                    # ALTER TABLE ADD COLUMN fails if the column already exists
                    # (e.g. if a prior deploy ran the DDL outside the migration
                    # tracker). Treat "duplicate column name" as already applied.
                    if "duplicate column name" not in str(exc).lower():
                        raise
                await conn.execute(
                    "INSERT INTO _migrations (filename) VALUES (?)", (mfile.name,)
                )
                await conn.commit()
