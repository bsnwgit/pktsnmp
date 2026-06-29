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

    async def get_device_latest_by_ip(self, device_ip: str) -> list[dict]:
        """Fallback for devices not yet registered (device_id = NULL)."""
        raise NotImplementedError

    async def query_poll_history_bucketed(
        self,
        device_id: int | None = None,
        device_ip: str | None = None,
        oid_labels: list[str] | None = None,
        since_iso: str | None = None,
        until_iso: str | None = None,
        bucket_seconds: int = 0,
        limit: int = 2000,
        if_index: int | None = None,            # legacy compat, ignored
        interface_label: str | None = None,     # filter by interface name (ifDescr)
    ) -> list[dict]:
        """Time-bucketed poll history for chart rendering."""
        raise NotImplementedError

    async def get_device_interfaces(self, device_id: int) -> list[dict]:
        """Interface list keyed by interface_label (ifDescr). Returns [{interface_label, name, ...}]."""
        raise NotImplementedError

    async def get_all_devices_latest(self, device_ids: list[int]) -> dict[int, list[dict]]:
        """Batch latest-value-per-oid_label for multiple devices. Returns {device_id: [rows]}."""
        raise NotImplementedError

    async def get_ingest_rate(
        self,
        collector_id: int | None = None,
        hours: int = 1,
        bucket_minutes: int = 5,
    ) -> list[dict]:
        """Polls-per-minute sparkline data for Collectors page."""
        raise NotImplementedError

    async def query_trap_events(
        self,
        device_id: int | None = None,
        device_ip: str | None = None,
        since_iso: str | None = None,
        until_iso: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Trap events for timeline overlay."""
        raise NotImplementedError

    async def get_metric_in_window(
        self,
        device_id: int | None,
        device_ip: str | None,
        oid_label: str,
        window_min: int,
    ) -> list[dict]:
        """Raw rows for alert engine evaluation."""
        raise NotImplementedError

    async def get_poll_gaps(self, collector_id: int, silence_minutes: int) -> bool:
        """True if no polls from collector in silence_minutes."""
        raise NotImplementedError

    async def get_device_last_poll(self, device_id: int | None, device_ip: str | None) -> str | None:
        """Most recent polled_at for a device."""
        raise NotImplementedError

    async def run_cleanup(self, retention_days: int) -> dict:
        """Delete rows older than retention_days. Returns {deleted_traps, deleted_poll_results}."""
        raise NotImplementedError
