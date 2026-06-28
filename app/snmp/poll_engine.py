"""
SNMP polling engine — single asyncio task, polls devices assigned to local collector.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable

import aiosqlite

log = logging.getLogger("pktsnmp.snmp.poll_engine")


def _decrypt(value: str) -> str:
    """Fernet-decrypt an SNMP credential key stored in SQLite."""
    try:
        import base64
        from cryptography.fernet import Fernet
        from app.config import get_settings
        key = get_settings().secret_key.encode()[:32].ljust(32, b"0")
        return Fernet(base64.urlsafe_b64encode(key)).decrypt(value.encode()).decode()
    except Exception:
        return ""


class PollEngine:
    def __init__(
        self,
        handler: Callable[[dict], Awaitable[None]],
        failure_handler: Callable[[int, str], Awaitable[None]] | None = None,
    ) -> None:
        self._handler = handler
        self._failure_handler = failure_handler
        self._task: asyncio.Task | None = None
        self._reload_event = asyncio.Event()
        self._stop_event = asyncio.Event()
        self._db_path: str = ""
        self._default_interval: int = 60
        self._max_concurrency: int = 10

    def signal_reload(self) -> None:
        """Signal the poll loop to reload devices and settings on the next iteration."""
        self._reload_event.set()

    async def start(self, db_path: str) -> None:
        self._db_path = db_path
        self._task = asyncio.create_task(self._run(), name="poll_engine")
        log.info("Poll engine started")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("Poll engine stopped")

    # ── Private helpers ───────────────────────────────────────────────────────

    async def _load_settings(self) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            async with db.execute(
                "SELECT key, value FROM settings WHERE key IN "
                "('snmp_poll_default_interval_seconds','snmp_poll_max_concurrency')"
            ) as cur:
                rows = await cur.fetchall()
        for row in rows:
            k, v = row[0], json.loads(row[1])
            if k == "snmp_poll_default_interval_seconds":
                self._default_interval = int(v)
            elif k == "snmp_poll_max_concurrency":
                self._max_concurrency = int(v)

    async def _load_devices(self) -> list[dict]:
        """Load local devices, resolving credentials from snmp_credentials table."""
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """SELECT d.id, d.ip, d.name, d.poll_interval_override,
                       COALESCE(NULLIF(d.snmp_version, ''), c.snmp_version, 'v2c') AS snmp_version,
                       COALESCE(NULLIF(d.community, ''), c.community, 'public') AS community,
                       COALESCE(NULLIF(d.security_name, ''), c.security_name, '') AS security_name,
                       COALESCE(NULLIF(d.security_level, ''), c.security_level, 'noAuthNoPriv') AS security_level,
                       COALESCE(NULLIF(d.auth_protocol, ''), c.auth_protocol, 'SHA256') AS auth_protocol,
                       COALESCE(d.auth_key_enc, c.auth_key_enc) AS auth_key_enc,
                       COALESCE(NULLIF(d.priv_protocol, ''), c.priv_protocol, 'AES128') AS priv_protocol,
                       COALESCE(d.priv_key_enc, c.priv_key_enc) AS priv_key_enc
                   FROM devices d
                   LEFT JOIN snmp_credentials c ON c.id = d.credential_id
                   WHERE d.collector_id=1 AND d.enabled=1"""
            ) as cur:
                rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def _load_oids(self) -> list[dict]:
        """Load OIDs to poll from oid_catalog — gauge and counter OIDs only."""
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT oid, name FROM oid_catalog WHERE data_type IN ('gauge','counter')"
            ) as cur:
                rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def _poll_device(self, device: dict, oids: list[dict]) -> list[dict]:
        """Poll a single device via pysnmp GET, returns list of result dicts."""
        from pysnmp.hlapi.asyncio import (
            getCmd,
            SnmpEngine,
            CommunityData,
            UsmUserData,
            UdpTransportTarget,
            ContextData,
            ObjectType,
            ObjectIdentity,
            usmHMACSHAAuthProtocol,
            usmHMACSHA256AuthProtocol,
            usmAesCfb128Protocol,
        )

        results: list[dict] = []
        start = time.monotonic()

        try:
            engine = SnmpEngine()
            target = UdpTransportTarget((device["ip"], 161), timeout=5, retries=1)
            ctx = ContextData()

            if device["snmp_version"] == "v3":
                auth_protocol_name = (device.get("auth_protocol") or "SHA256").upper()
                auth_proto = (
                    usmHMACSHA256AuthProtocol
                    if "256" in auth_protocol_name
                    else usmHMACSHAAuthProtocol
                )
                # Decrypt Fernet-encrypted keys from DB
                raw_auth = device.get("auth_key_enc") or ""
                raw_priv = device.get("priv_key_enc") or ""
                auth_data = UsmUserData(
                    device.get("security_name") or "",
                    authKey=_decrypt(raw_auth) if raw_auth else None,
                    privKey=_decrypt(raw_priv) if raw_priv else None,
                    authProtocol=auth_proto,
                    privProtocol=usmAesCfb128Protocol,
                )
            else:
                auth_data = CommunityData(device.get("community") or "public")

            # Limit OIDs per poll cycle to avoid overwhelming the device
            for oid_entry in oids[:20]:
                oid_str = oid_entry["oid"]
                oid_label = oid_entry["name"]
                try:
                    error_indication, error_status, error_index, var_binds = await getCmd(
                        engine,
                        auth_data,
                        target,
                        ctx,
                        ObjectType(ObjectIdentity(oid_str)),
                    )
                    if error_indication or error_status:
                        continue
                    for var_bind in var_binds:
                        val = var_bind[1]
                        duration_ms = int((time.monotonic() - start) * 1000)
                        try:
                            val_numeric: float | None = float(int(val))
                        except Exception:
                            val_numeric = None
                        results.append(
                            {
                                "collector_id": 1,
                                "device_id": device["id"],
                                "device_ip": device["ip"],
                                "oid": oid_str,
                                "oid_label": oid_label,
                                "value": str(val),
                                "value_numeric": val_numeric,
                                "value_type": "gauge",
                                "poll_duration_ms": duration_ms,
                                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                            }
                        )
                except Exception as e:
                    log.debug(f"OID {oid_str} failed for {device['ip']}: {e}")

        except Exception as e:
            log.warning(f"Poll failed for device {device['ip']}: {e}")

        return results

    async def _update_device_status(
        self,
        device_id: int,
        status: str,
        last_error: str | None = None,
    ) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                "UPDATE devices SET status=?, last_seen=?, last_error=?, "
                "updated_at=datetime('now') WHERE id=?",
                (
                    status,
                    datetime.now(tz=timezone.utc).isoformat(),
                    last_error,
                    device_id,
                ),
            )
            await db.commit()

    async def _run(self) -> None:
        await self._load_settings()
        devices = await self._load_devices()
        oids = await self._load_oids()

        # next_poll_at: device_id -> monotonic timestamp
        next_poll: dict[int, float] = {d["id"]: time.monotonic() for d in devices}

        log.info(
            f"Poll engine: {len(devices)} local devices, "
            f"interval={self._default_interval}s, max_concurrency={self._max_concurrency}"
        )

        while not self._stop_event.is_set():
            try:
                # Handle reload signal
                if self._reload_event.is_set():
                    self._reload_event.clear()
                    await self._load_settings()
                    devices = await self._load_devices()
                    oids = await self._load_oids()
                    for d in devices:
                        if d["id"] not in next_poll:
                            next_poll[d["id"]] = time.monotonic()
                    log.info(f"Poll engine reloaded: {len(devices)} devices")

                now = time.monotonic()
                due = [d for d in devices if next_poll.get(d["id"], 0) <= now]

                if due:
                    sem = asyncio.Semaphore(self._max_concurrency)

                    async def poll_with_sem(device: dict) -> None:
                        async with sem:
                            try:
                                poll_results = await self._poll_device(device, oids)
                                interval = (
                                    device.get("poll_interval_override") or self._default_interval
                                )
                                next_poll[device["id"]] = time.monotonic() + interval
                                if poll_results:
                                    for r in poll_results:
                                        await self._handler(r)
                                    await self._update_device_status(device["id"], "up")
                                else:
                                    await self._update_device_status(
                                        device["id"], "down", "No OIDs returned"
                                    )
                                    if self._failure_handler:
                                        await self._failure_handler(device["id"], device["ip"])
                            except Exception as e:
                                log.error(f"Poll task error for {device['ip']}: {e}")
                                await self._update_device_status(
                                    device["id"], "down", str(e)
                                )
                                if self._failure_handler:
                                    await self._failure_handler(device["id"], device["ip"])

                    await asyncio.gather(*[poll_with_sem(d) for d in due])

                # Sleep until next device is due (max 5 seconds)
                if next_poll:
                    sleep_until = min(next_poll.values())
                    sleep_for = max(0.1, min(5.0, sleep_until - time.monotonic()))
                else:
                    sleep_for = 5.0

                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._reload_event.wait()),
                        timeout=sleep_for,
                    )
                except asyncio.TimeoutError:
                    pass

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Poll engine loop error: {e}")
                await asyncio.sleep(5)
