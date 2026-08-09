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
    from app.crypto import decrypt_str
    try:
        return decrypt_str(value)
    except Exception:
        return ""


# IF-MIB ifEntry columns (ifTable) are indexed per-interface — a bare GET on the
# column OID returns nothing. ifName (ifXTable) gives a unique label to tag rows
# with; ifDescr is a fallback for older devices without ifXTable, but ifDescr is
# often identical across ports sharing the same hardware/driver, so it collides.
IF_ENTRY_PREFIX = "1.3.6.1.2.1.2.2.1."
IFNAME_OID = "1.3.6.1.2.1.31.1.1.1.1"
IFDESCR_OID = "1.3.6.1.2.1.2.2.1.2"
IFALIAS_OID = "1.3.6.1.2.1.31.1.1.1.18"

# Topology OIDs — walked unconditionally per device (independent of the
# gauge/counter oid_catalog above) to populate the arp_entries/routes/
# interfaces tables the Suite Integration API exposes to sibling apps
# (currently pktIPAM). Same MIB columns pktIPAM's own snmp_generic device
# collector walks directly — see [[pktipam-routing-tables-idea]].
ARP_PHYS_ADDR_OID = "1.3.6.1.2.1.4.22.1.2"          # ipNetToMediaPhysAddress
DOT1D_BASE_PORT_IF_INDEX_OID = "1.3.6.1.2.1.17.1.4.1.2"
DOT1Q_PVID_OID = "1.3.6.1.2.1.17.7.1.4.5.1.1"

# IP-FORWARD-MIB ipCidrRouteTable — INDEX is {ipCidrRouteDest,
# ipCidrRouteMask, ipCidrRouteTos, ipCidrRouteNextHop} (4+4+1+4 = 13
# sub-identifiers after the column OID), so every column walk below
# shares the same 13-part suffix and rows are correlated by it.
ROUTE_IF_INDEX_OID = "1.3.6.1.2.1.4.24.4.1.5"
ROUTE_PROTO_OID = "1.3.6.1.2.1.4.24.4.1.7"
ROUTE_METRIC1_OID = "1.3.6.1.2.1.4.24.4.1.11"

# ipCidrRouteProto enumeration — codes not listed here fall back to "other".
ROUTE_PROTO_NAMES = {
    2: "local", 3: "static", 4: "icmp", 5: "egp", 6: "ggp", 7: "hello",
    8: "rip", 9: "is-is", 10: "es-is", 11: "igrp", 12: "bbn-spf-igp",
    13: "ospf", 14: "bgp", 15: "idpr", 16: "eigrp",
}


def _mac_from_bytes(value) -> str:
    raw = bytes(value)
    return ":".join(f"{b:02x}" for b in raw) if raw else ""


def _mask_to_prefixlen(mask: str) -> int:
    import ipaddress
    return ipaddress.IPv4Network(f"0.0.0.0/{mask}").prefixlen


async def _walk_column(engine, auth_data, target, ctx, root_oid: str, max_rows: int = 128, batch: int = 25) -> dict[str, object]:
    """GETBULK-walk every instance under root_oid, keyed by the OID suffix (row index)."""
    from pysnmp.hlapi.asyncio import bulkCmd, ObjectType, ObjectIdentity

    out: dict[str, object] = {}
    next_oid = root_oid
    while len(out) < max_rows:
        error_indication, error_status, _error_index, var_bind_table = await bulkCmd(
            engine, auth_data, target, ctx, 0, batch,
            ObjectType(ObjectIdentity(next_oid)),
        )
        if error_indication or error_status or not var_bind_table:
            break
        done = False
        for row in var_bind_table:
            oid_str, value = row[0]
            oid_str = str(oid_str)
            if oid_str == root_oid or not oid_str.startswith(root_oid + "."):
                done = True
                break
            out[oid_str[len(root_oid) + 1:]] = value
            next_oid = oid_str
            if len(out) >= max_rows:
                break
        if done:
            break
    return out


async def _poll_topology(engine, auth_data, target, ctx, if_labels: dict[str, str]) -> dict[str, list[dict]]:
    """Walks ARP (ipNetToMediaTable), per-port VLAN (dot1qPvid), and the
    IPv4 routing table (ipCidrRouteTable) — reuses the caller's already-open
    engine/auth_data/target/ctx (and its already-walked if_labels) rather
    than opening a second SnmpEngine, since it's the same device either
    way. Each walk is independently non-fatal: a device with no route
    table support (or no VLAN MIB) still reports its ARP table, etc.
    Returns {"arp": [...], "routes": [...], "interfaces": [...]}.
    """
    arp: list[dict] = []
    routes: list[dict] = []
    interfaces: list[dict] = [
        {"if_index": if_index, "if_name": name} for if_index, name in if_labels.items()
    ]

    # -- dot1dBasePort -> ifIndex, then ifIndex -> PVID (best-effort VLAN) ----------
    port_to_vlan: dict[str, int] = {}
    try:
        base_port_to_ifindex = {
            suffix: str(value)
            for suffix, value in (await _walk_column(engine, auth_data, target, ctx, DOT1D_BASE_PORT_IF_INDEX_OID)).items()
        }
        pvid_raw = await _walk_column(engine, auth_data, target, ctx, DOT1Q_PVID_OID)
        for base_port, pvid in pvid_raw.items():
            if_index = base_port_to_ifindex.get(base_port)
            if if_index:
                port_to_vlan[if_index] = int(pvid)
        for iface in interfaces:
            vlan = port_to_vlan.get(iface["if_index"])
            if vlan is not None:
                iface["vlan_tag"] = vlan
    except Exception as e:
        log.debug(f"VLAN mapping (dot1dBasePortIfIndex/dot1qPvid) unavailable: {e}")

    # -- ipNetToMediaTable (ARP: IP <-> MAC per ifIndex) -----------------------------
    # INDEX is {ipNetToMediaIfIndex, ipNetToMediaNetAddress} — suffix is
    # <ifIndex>.<ip1>.<ip2>.<ip3>.<ip4>.
    try:
        raw = await _walk_column(engine, auth_data, target, ctx, ARP_PHYS_ADDR_OID)
        for suffix, value in raw.items():
            parts = suffix.split(".")
            if len(parts) < 5:
                continue
            if_index = parts[0]
            entry_ip = ".".join(parts[-4:])
            mac = _mac_from_bytes(value)
            if not mac or mac == "00:00:00:00:00:00":
                continue
            arp.append({
                "ip_address": entry_ip, "mac_address": mac,
                "interface_label": if_labels.get(if_index, if_index),
                "vlan_tag": port_to_vlan.get(if_index),
            })
    except Exception as e:
        log.debug(f"ipNetToMediaTable walk failed: {e}")

    # -- ipCidrRouteTable (routing table) --------------------------------------------
    try:
        route_if_index = {
            suffix: str(value)
            for suffix, value in (await _walk_column(engine, auth_data, target, ctx, ROUTE_IF_INDEX_OID)).items()
        }
    except Exception as e:
        route_if_index = {}
        log.debug(f"ipCidrRouteTable walk unavailable: {e}")

    if route_if_index:
        try:
            route_proto = {
                suffix: int(value)
                for suffix, value in (await _walk_column(engine, auth_data, target, ctx, ROUTE_PROTO_OID)).items()
            }
        except Exception as e:
            route_proto = {}
            log.debug(f"ipCidrRouteProto walk unavailable: {e}")

        try:
            route_metric = {
                suffix: int(value)
                for suffix, value in (await _walk_column(engine, auth_data, target, ctx, ROUTE_METRIC1_OID)).items()
            }
        except Exception as e:
            route_metric = {}
            log.debug(f"ipCidrRouteMetric1 walk unavailable: {e}")

        for suffix, if_index in route_if_index.items():
            parts = suffix.split(".")
            if len(parts) != 13:
                continue
            dest = ".".join(parts[0:4])
            mask = ".".join(parts[4:8])
            next_hop = ".".join(parts[9:13])
            try:
                prefixlen = _mask_to_prefixlen(mask)
            except ValueError:
                continue
            proto_code = route_proto.get(suffix)
            routes.append({
                "destination": f"{dest}/{prefixlen}",
                "next_hop": next_hop if next_hop != "0.0.0.0" else None,
                "interface_label": if_labels.get(if_index, if_index),
                "protocol": ROUTE_PROTO_NAMES.get(proto_code, "other") if proto_code else None,
                "metric": route_metric.get(suffix),
            })

    return {"arp": arp, "routes": routes, "interfaces": interfaces}


async def _persist_topology(db_path: str, device_id: int, topology: dict[str, list[dict]]) -> None:
    """Full-replace-on-poll, same pattern as pktIPAM's own arp_entries/
    routes tables — each poll is a complete current-state snapshot."""
    async with aiosqlite.connect(db_path) as db:
        await db.execute("DELETE FROM arp_entries WHERE device_id = ?", (device_id,))
        for e in topology["arp"]:
            await db.execute(
                """INSERT OR IGNORE INTO arp_entries
                   (device_id, ip_address, mac_address, interface_label, vlan_tag, last_seen)
                   VALUES (?, ?, ?, ?, ?, datetime('now'))""",
                (device_id, e["ip_address"], e["mac_address"], e["interface_label"], e.get("vlan_tag")),
            )

        await db.execute("DELETE FROM routes WHERE device_id = ?", (device_id,))
        for r in topology["routes"]:
            await db.execute(
                """INSERT OR IGNORE INTO routes
                   (device_id, destination, next_hop, interface_label, protocol, metric, last_seen)
                   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
                (device_id, r["destination"], r["next_hop"], r["interface_label"], r["protocol"], r["metric"]),
            )

        await db.execute("DELETE FROM interfaces WHERE device_id = ?", (device_id,))
        for i in topology["interfaces"]:
            await db.execute(
                """INSERT OR IGNORE INTO interfaces
                   (device_id, if_index, if_name, vlan_tag, last_seen)
                   VALUES (?, ?, ?, ?, datetime('now'))""",
                (device_id, i["if_index"], i.get("if_name"), i.get("vlan_tag")),
            )

        await db.commit()


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
            usmHMAC192SHA256AuthProtocol,
            usmAesCfb128Protocol,
        )

        results: list[dict] = []
        start = time.monotonic()
        engine: SnmpEngine | None = None

        try:
            engine = SnmpEngine()
            target = UdpTransportTarget((device["ip"], 161), timeout=5, retries=1)
            ctx = ContextData()

            if device["snmp_version"] == "v3":
                auth_protocol_name = (device.get("auth_protocol") or "SHA256").upper()
                auth_proto = (
                    usmHMAC192SHA256AuthProtocol
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
                raw_community = device.get("community") or "public"
                auth_data = CommunityData(_decrypt(raw_community) or raw_community)

            # Poll every catalog OID — vendor-specific / inapplicable ones just get a
            # fast noSuchObject/noSuchInstance response from the agent and are skipped
            # below, so this doesn't meaningfully slow down a poll cycle. A previous
            # `oids[:20]` cap silently dropped every OID catalog row past position 20
            # (rowid order, not relevance), which happened to exclude every
            # HOST-RESOURCES-MIB (hr*) and vendor-specific (pan*/cisco*/etc.) OID —
            # System Resources and vendor health panels never had any data as a result.
            polled_oids = oids

            # ifTable columns are indexed per-interface — resolve ifIndex -> ifDescr
            # once so those rows can be labeled, instead of GETting the bare column OID.
            # Walked unconditionally (not just when the oid_catalog polls ifTable
            # columns) since the topology walk below (ARP/routes/interfaces) needs
            # interface labels regardless of what gauge/counter OIDs are configured.
            if_labels: dict[str, str] = {}
            try:
                raw = await _walk_column(engine, auth_data, target, ctx, IFNAME_OID)
                if not raw:
                    raw = await _walk_column(engine, auth_data, target, ctx, IFDESCR_OID)
                if_labels = {k: str(v) for k, v in raw.items()}
            except Exception as e:
                log.debug(f"ifName/ifDescr walk failed for {device['ip']}: {e}")

            if any(o["oid"].startswith(IF_ENTRY_PREFIX) for o in polled_oids):
                # ifAlias is the operator-assigned description (e.g. "WAN", "Guest VLAN") —
                # not part of the gauge/counter catalog, so it needs its own walk to surface it.
                try:
                    alias_raw = await _walk_column(engine, auth_data, target, ctx, IFALIAS_OID)
                    duration_ms = int((time.monotonic() - start) * 1000)
                    for suffix, alias_val in alias_raw.items():
                        alias_str = str(alias_val)
                        if not alias_str:
                            continue
                        results.append(
                            {
                                "collector_id": 1,
                                "device_id": device["id"],
                                "device_ip": device["ip"],
                                "oid": IFALIAS_OID,
                                "oid_label": "ifAlias",
                                "interface_label": if_labels.get(suffix, suffix),
                                "value": alias_str,
                                "value_numeric": None,
                                "value_type": "string",
                                "poll_duration_ms": duration_ms,
                                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                            }
                        )
                except Exception as e:
                    log.debug(f"ifAlias walk failed for {device['ip']}: {e}")

            # ARP table, routing table, and per-port VLAN — independent of the
            # oid_catalog, feeds the Suite Integration topology endpoints.
            try:
                topology = await _poll_topology(engine, auth_data, target, ctx, if_labels)
                await _persist_topology(self._db_path, device["id"], topology)
            except Exception as e:
                log.warning(f"Topology poll (ARP/routes/interfaces) failed for {device['ip']}: {e}")

            for oid_entry in polled_oids:
                oid_str = oid_entry["oid"]
                oid_label = oid_entry["name"]
                is_table_column = not oid_str.endswith(".0")
                try:
                    if is_table_column:
                        values = await _walk_column(engine, auth_data, target, ctx, oid_str)
                        duration_ms = int((time.monotonic() - start) * 1000)
                        for suffix, val in values.items():
                            iface_label = if_labels.get(suffix, suffix) if oid_str.startswith(IF_ENTRY_PREFIX) else suffix
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
                                    "interface_label": iface_label,
                                    "value": str(val),
                                    "value_numeric": val_numeric,
                                    "value_type": "gauge",
                                    "poll_duration_ms": duration_ms,
                                    "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                                }
                            )
                    else:
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
                                val_numeric = float(int(val))
                            except Exception:
                                val_numeric = None
                            results.append(
                                {
                                    "collector_id": 1,
                                    "device_id": device["id"],
                                    "device_ip": device["ip"],
                                    "oid": oid_str,
                                    "oid_label": oid_label,
                                    "interface_label": "",
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
        finally:
            # SnmpEngine holds an open UDP socket via its transport dispatcher —
            # never closing it leaks one fd per device per poll cycle, eventually
            # exhausting the process's open-file limit.
            if engine is not None:
                try:
                    engine.closeDispatcher()
                except Exception as e:
                    log.debug(f"closeDispatcher failed for {device['ip']}: {e}")

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
