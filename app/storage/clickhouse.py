"""
ClickHouse storage backend for pktSNMP — stub implementation.
Full schema and queries to be implemented when SNMP data model is defined.
"""
from __future__ import annotations

import logging
from typing import Any

from app.storage.base import StorageBase

log = logging.getLogger("pktsnmp.storage.clickhouse")


class ClickHouseStorage(StorageBase):
    def __init__(
        self,
        host: str = "localhost",
        port: int = 9000,
        database: str = "pktsnmp",
        user: str = "default",
        password: str = "",
    ) -> None:
        self.host     = host
        self.port     = port
        self.database = database
        self.user     = user
        self.password = password
        self._client  = None

    async def connect(self) -> None:
        from clickhouse_driver import Client
        self._client = Client(
            host=self.host,
            port=self.port,
            database=self.database,
            user=self.user,
            password=self.password,
            settings={"use_numpy": False},
        )
        log.info(f"ClickHouse connected: {self.host}:{self.port}/{self.database}")

    async def close(self) -> None:
        if self._client:
            try:
                self._client.disconnect()
            except Exception:
                pass
        self._client = None

    def _execute(self, query: str, params: Any = None):
        """Execute a ClickHouse query synchronously."""
        if params is not None:
            return self._client.execute(query, params)
        return self._client.execute(query)

    def health_check(self) -> dict:
        try:
            rows = self._execute("SELECT 1")
            return {"ok": True, "message": "ClickHouse reachable"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    # ── SNMP data methods ─────────────────────────────────────────────────────
    # TODO: implement once SNMP data schema is finalized

    async def ingest_trap(self, trap: dict) -> None:
        raise NotImplementedError("ClickHouse SNMP trap ingest not yet implemented")

    async def ingest_poll_result(self, result: dict) -> None:
        raise NotImplementedError("ClickHouse SNMP poll ingest not yet implemented")

    async def query_traps(self, **kwargs: Any) -> list[dict]:
        raise NotImplementedError("ClickHouse SNMP trap query not yet implemented")

    async def query_poll_history(self, **kwargs: Any) -> list[dict]:
        raise NotImplementedError("ClickHouse SNMP poll history query not yet implemented")
