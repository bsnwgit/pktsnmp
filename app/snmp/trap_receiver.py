"""
SNMP trap receiver — asyncio DatagramProtocol UDP listener.
Requires CAP_NET_BIND_SERVICE for port 162 (configured in pktsnmp.service).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from pyasn1.codec.ber import decoder
from pysnmp.proto import api as snmp_api

log = logging.getLogger("pktsnmp.snmp.trap_receiver")


class _TrapProtocol(asyncio.DatagramProtocol):
    def __init__(
        self,
        handler: Callable[[dict], Awaitable[None]],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._handler = handler
        self._loop = loop

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        source_ip = addr[0]
        try:
            trap = self._parse_raw(data, source_ip)
            asyncio.run_coroutine_threadsafe(self._handler(trap), self._loop)
        except Exception as e:
            log.warning(f"Trap parse error from {source_ip}: {e}")

    def _parse_raw(self, data: bytes, source_ip: str) -> dict:
        """Parse raw SNMP trap bytes using pysnmp-lextudio."""
        try:
            msg_ver = int(snmp_api.decodeMessageVersion(data))

            if msg_ver == snmp_api.protoVersion1:
                pmod = snmp_api.protoModules[snmp_api.protoVersion1]
                msg, _ = decoder.decode(data, asn1Spec=pmod.Message())
                community = str(msg.getComponentByPosition(1))
                pdu = pmod.apiMessage.getPDU(msg)

                varbinds = []
                for oid, val in pmod.apiPDU.getVarBinds(pdu):
                    varbinds.append(
                        {
                            "oid": str(oid),
                            "value": str(val),
                            "type": type(val).__name__,
                        }
                    )

                trap_oid = ""
                for vb in varbinds:
                    if vb["oid"] == "1.3.6.1.6.3.1.1.4.1.0":
                        trap_oid = vb["value"]
                        break

                return {
                    "source_ip": source_ip,
                    "version": "v1",
                    "community": community,
                    "trap_oid": trap_oid,
                    "varbinds": varbinds,
                    "collector_id": 1,
                }

            elif msg_ver == snmp_api.protoVersion2c:
                pmod = snmp_api.protoModules[snmp_api.protoVersion2c]
                msg, _ = decoder.decode(data, asn1Spec=pmod.Message())
                community = str(msg.getComponentByPosition(1))
                pdu = pmod.apiMessage.getPDU(msg)

                varbinds = []
                for oid, val in pmod.apiPDU.getVarBinds(pdu):
                    varbinds.append(
                        {
                            "oid": str(oid),
                            "value": str(val),
                            "type": type(val).__name__,
                        }
                    )

                trap_oid = ""
                for vb in varbinds:
                    if vb["oid"] == "1.3.6.1.6.3.1.1.4.1.0":
                        trap_oid = vb["value"]
                        break

                return {
                    "source_ip": source_ip,
                    "version": "v2c",
                    "community": community,
                    "trap_oid": trap_oid,
                    "varbinds": varbinds,
                    "collector_id": 1,
                }

            else:
                log.debug(f"Unsupported SNMP version {msg_ver} from {source_ip}, storing raw")
                return {
                    "source_ip": source_ip,
                    "version": f"v{msg_ver}",
                    "community": "",
                    "trap_oid": "",
                    "varbinds": [],
                    "collector_id": 1,
                }

        except Exception as e:
            log.debug(f"pysnmp decode failed for {source_ip}, storing raw: {e}")

        # Fallback: store minimal trap info
        return {
            "source_ip": source_ip,
            "version": "unknown",
            "community": "",
            "trap_oid": "",
            "varbinds": [],
            "collector_id": 1,
        }

    def error_received(self, exc: Exception) -> None:
        log.warning(f"UDP error: {exc}")

    def connection_lost(self, exc: Exception | None) -> None:
        log.info("Trap receiver UDP connection closed")


class TrapReceiver:
    def __init__(
        self,
        host: str,
        port: int,
        handler: Callable[[dict], Awaitable[None]],
    ) -> None:
        self._host = host
        self._port = port
        self._handler = handler
        self._transport: asyncio.BaseTransport | None = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            import socket

            self._transport, _ = await loop.create_datagram_endpoint(
                lambda: _TrapProtocol(self._handler, loop),
                local_addr=(self._host, self._port),
                family=socket.AF_INET6,
                allow_broadcast=True,
            )
            log.info(f"Trap receiver listening (IPv6 dual-stack) on {self._host}:{self._port}")
        except OSError:
            # Fallback to IPv4
            self._transport, _ = await loop.create_datagram_endpoint(
                lambda: _TrapProtocol(self._handler, loop),
                local_addr=(self._host, self._port),
            )
            log.info(f"Trap receiver listening (IPv4) on UDP {self._host}:{self._port}")

    async def stop(self) -> None:
        if self._transport:
            self._transport.close()
            self._transport = None
        log.info("Trap receiver stopped")
