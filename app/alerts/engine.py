"""
Alert engine stub — SNMP-specific alerting to be implemented in a later sprint.
See TODO.md for planned alert types (trap threshold, poll OID threshold, device down, etc.).
"""
from __future__ import annotations

import logging

log = logging.getLogger("pktsnmp.alerts.engine")


class AlertEngine:
    """Placeholder alert engine. Wire into main.py startup/shutdown."""

    async def start(self) -> None:
        log.info("Alert engine started (stub — no rules evaluated yet)")

    async def stop(self) -> None:
        log.info("Alert engine stopped")
