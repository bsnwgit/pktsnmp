"""
Abstract base class for pktSNMP storage backends.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class StorageBase(ABC):

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    def health_check(self) -> dict: ...

    async def ingest_trap(self, trap: dict) -> None:
        raise NotImplementedError

    async def ingest_poll_result(self, result: dict) -> None:
        raise NotImplementedError

    async def query_traps(
        self,
        collector_id: int | None = None,
        device_ip: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        raise NotImplementedError

    async def query_poll_history(
        self,
        device_id: int | None = None,
        oid_label: str | None = None,
        since: str | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        raise NotImplementedError

    async def get_device_latest(self, device_id: int) -> list[dict]:
        """Get the latest value per oid_label for a device."""
        raise NotImplementedError

    async def run_cleanup(self, retention_days: int) -> dict:
        """Delete rows older than retention_days. Returns {deleted_traps, deleted_poll_results}."""
        raise NotImplementedError
