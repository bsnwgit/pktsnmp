"""
OID catalog — bundled well-known OIDs and helpers for seeding / lookup.
"""
from __future__ import annotations

import logging
from typing import Any

import aiosqlite

log = logging.getLogger("pktsnmp.snmp.oid_catalog")

# ---------------------------------------------------------------------------
# Bundled OID definitions
# ---------------------------------------------------------------------------

BUNDLED_OIDS: list[dict[str, str]] = [
    # ── System MIB (RFC 1213 / SNMPv2-MIB) ─────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.1.1.0",
        "name": "sysDescr",
        "description": "A textual description of the entity (system description string).",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.1.2.0",
        "name": "sysObjectID",
        "description": "The vendor's authoritative identification of the network management subsystem.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.1.3.0",
        "name": "sysUpTime",
        "description": "Time (in hundredths of a second) since the network management portion of the system was last re-initialized.",
        "unit": "timeticks",
        "data_type": "timeticks",
    },
    {
        "oid": "1.3.6.1.2.1.1.4.0",
        "name": "sysContact",
        "description": "The textual identification of the contact person for this managed node.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.1.5.0",
        "name": "sysName",
        "description": "An administratively-assigned name for this managed node (fully qualified domain name).",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.1.6.0",
        "name": "sysLocation",
        "description": "The physical location of this node.",
        "unit": "",
        "data_type": "string",
    },

    # ── Interfaces MIB (IF-MIB / RFC 2863) ──────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.2.1.0",
        "name": "ifNumber",
        "description": "The number of network interfaces present on this system.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.2",
        "name": "ifDescr",
        "description": "A textual string containing information about the interface.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.3",
        "name": "ifType",
        "description": "The type of interface, distinguished according to the physical/link protocol(s).",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.4",
        "name": "ifMtu",
        "description": "The size of the largest packet which can be sent/received on the interface.",
        "unit": "bytes",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.5",
        "name": "ifSpeed",
        "description": "An estimate of the interface's current bandwidth in bits per second.",
        "unit": "bps",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.6",
        "name": "ifPhysAddress",
        "description": "The interface's address at the protocol layer immediately below the network layer.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.7",
        "name": "ifAdminStatus",
        "description": "The desired state of the interface (1=up, 2=down, 3=testing).",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.8",
        "name": "ifOperStatus",
        "description": "The current operational state of the interface (1=up, 2=down, 3=testing, ...).",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.10",
        "name": "ifInOctets",
        "description": "The total number of octets received on the interface, including framing characters.",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.11",
        "name": "ifInUcastPkts",
        "description": "The number of subnetwork-unicast packets delivered to a higher-layer protocol.",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.13",
        "name": "ifInDiscards",
        "description": "The number of inbound packets discarded even though no errors were detected.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.14",
        "name": "ifInErrors",
        "description": "The number of inbound packets that contained errors preventing delivery to higher-layer protocols.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.16",
        "name": "ifOutOctets",
        "description": "The total number of octets transmitted out of the interface, including framing characters.",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.17",
        "name": "ifOutUcastPkts",
        "description": "The total number of packets that higher-level protocols requested be transmitted to a subnetwork-unicast address.",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.19",
        "name": "ifOutDiscards",
        "description": "The number of outbound packets discarded even though no errors were detected.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.2.2.1.20",
        "name": "ifOutErrors",
        "description": "The number of outbound packets that could not be transmitted because of errors.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.1",
        "name": "ifName",
        "description": "The textual name of the interface as assigned by the local device.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.15",
        "name": "ifHighSpeed",
        "description": "An estimate of the interface's current bandwidth in units of 1,000,000 bits per second.",
        "unit": "mbps",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.18",
        "name": "ifAlias",
        "description": "This object is an alias name for the interface as specified by a network manager.",
        "unit": "",
        "data_type": "string",
    },

    # ── IP MIB (RFC 1213) ────────────────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.4.1.0",
        "name": "ipForwarding",
        "description": "The indication of whether this entity is acting as an IP gateway (1=forwarding, 2=not-forwarding).",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.4.3.0",
        "name": "ipInReceives",
        "description": "The total number of input datagrams received from interfaces, including those received in error.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.4.9.0",
        "name": "ipInDelivers",
        "description": "The total number of input datagrams successfully delivered to IP user-protocols.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.4.10.0",
        "name": "ipOutRequests",
        "description": "The total number of IP datagrams which local IP user-protocols supplied to IP in requests for transmission.",
        "unit": "",
        "data_type": "counter",
    },

    # ── TCP MIB (RFC 1213) ───────────────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.6.5.0",
        "name": "tcpActiveOpens",
        "description": "The number of times TCP connections have made a direct transition to the SYN-SENT state from the CLOSED state.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.10.0",
        "name": "tcpInSegs",
        "description": "The total number of segments received, including those received in error.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.11.0",
        "name": "tcpOutSegs",
        "description": "The total number of segments sent, including those on current connections but excluding those containing only retransmitted octets.",
        "unit": "",
        "data_type": "counter",
    },

    # ── UDP MIB (RFC 1213) ───────────────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.7.1.0",
        "name": "udpInDatagrams",
        "description": "The total number of UDP datagrams delivered to UDP users.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.7.4.0",
        "name": "udpOutDatagrams",
        "description": "The total number of UDP datagrams sent from this entity.",
        "unit": "",
        "data_type": "counter",
    },

    # ── HOST-RESOURCES MIB (RFC 2790) ────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.25.1.1.0",
        "name": "hrSystemUptime",
        "description": "The amount of time since this host was last initialized.",
        "unit": "timeticks",
        "data_type": "timeticks",
    },
    {
        "oid": "1.3.6.1.2.1.25.1.5.0",
        "name": "hrSystemNumUsers",
        "description": "The number of user sessions for which this host is storing state information.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.25.3.3.1.2",
        "name": "hrProcessorLoad",
        "description": "The average, over the last minute, of the percentage of time that this processor was not idle.",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.25.2.3.1.5",
        "name": "hrStorageSize",
        "description": "The size of the storage represented by this entry, in units of hrStorageAllocationUnits.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.25.2.3.1.6",
        "name": "hrStorageUsed",
        "description": "The amount of the storage represented by this entry that is allocated, in units of hrStorageAllocationUnits.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.25.2.2.0",
        "name": "hrMemorySize",
        "description": "The amount of physical read-write main memory, in kilobytes, present in this host.",
        "unit": "bytes",
        "data_type": "gauge",
    },

    # ── ENTITY MIB (RFC 4133) ────────────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.47.1.1.1.1.2",
        "name": "entPhysicalDescr",
        "description": "A textual description of physical component.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.47.1.1.1.1.7",
        "name": "entPhysicalName",
        "description": "The textual name of the physical component.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.47.1.1.1.1.10",
        "name": "entPhysicalSoftwareRev",
        "description": "The vendor-specific software revision string for the physical entity.",
        "unit": "",
        "data_type": "string",
    },

    # ── BGP MIB (RFC 4271) ───────────────────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.15.2.0",
        "name": "bgpLocalAs",
        "description": "The local autonomous system number.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.15.3.1.2",
        "name": "bgpPeerState",
        "description": "The BGP peer connection state (1=idle, 2=connect, 3=active, 4=opensent, 5=openconfirm, 6=established).",
        "unit": "",
        "data_type": "gauge",
    },

    # ── IF-MIB Extension (ifXTable, RFC 2863) — 64-bit HC counters ──────────
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.6",
        "name": "ifHCInOctets",
        "description": "The total number of octets received on the interface (64-bit counter). Use instead of ifInOctets on high-speed links.",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.7",
        "name": "ifHCInUcastPkts",
        "description": "The number of packets delivered to a higher-layer protocol (64-bit counter).",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.10",
        "name": "ifHCOutOctets",
        "description": "The total number of octets transmitted out of the interface (64-bit counter). Use instead of ifOutOctets on high-speed links.",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.31.1.1.1.11",
        "name": "ifHCOutUcastPkts",
        "description": "The total number of packets transmitted to a higher-layer protocol (64-bit counter).",
        "unit": "packets",
        "data_type": "counter",
    },

    # ── Palo Alto PAN-OS MIB (PAN-COMMON-MIB, enterprise .1.3.6.1.4.1.25461) ─
    # System resources
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.10.0",
        "name": "panSysCpuUtilMgmt",
        "description": "PAN-OS management-plane CPU utilization percentage.",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.11.0",
        "name": "panSysCpuUtilDataPlane",
        "description": "PAN-OS data-plane CPU utilization percentage.",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.14.0",
        "name": "panSysMemUsed",
        "description": "PAN-OS memory currently in use, in kilobytes.",
        "unit": "kilobytes",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.15.0",
        "name": "panSysMemAvail",
        "description": "PAN-OS memory currently available, in kilobytes.",
        "unit": "kilobytes",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.6.0",
        "name": "panSysSwVersion",
        "description": "PAN-OS software version string (e.g. '10.2.4-h4').",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.2.0",
        "name": "panSysHwVersion",
        "description": "PAN-OS hardware model/version string.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.1.16.0",
        "name": "panSysSwapUsed",
        "description": "PAN-OS swap space currently in use, in kilobytes.",
        "unit": "kilobytes",
        "data_type": "gauge",
    },
    # Session table
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.2.0",
        "name": "panSessionUtilization",
        "description": "PAN-OS session table utilization percentage.",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.3.0",
        "name": "panSessionMax",
        "description": "PAN-OS maximum number of sessions supported.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.4.0",
        "name": "panSessionActive",
        "description": "PAN-OS number of currently active sessions.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.5.0",
        "name": "panSessionActiveTcp",
        "description": "PAN-OS number of active TCP sessions.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.6.0",
        "name": "panSessionActiveUdp",
        "description": "PAN-OS number of active UDP sessions.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.3.7.0",
        "name": "panSessionActiveICMP",
        "description": "PAN-OS number of active ICMP sessions.",
        "unit": "",
        "data_type": "gauge",
    },
    # panIfStatsTable — per-interface traffic counters (indexed by interface name string)
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.1",
        "name": "panIfStatsIfname",
        "description": "PAN-OS interface name (table index column of panIfStatsTable).",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.3",
        "name": "panIfStatsIfinBytes",
        "description": "PAN-OS bytes received on this interface (per panIfStatsTable row).",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.4",
        "name": "panIfStatsIfoutBytes",
        "description": "PAN-OS bytes transmitted on this interface (per panIfStatsTable row).",
        "unit": "bytes",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.5",
        "name": "panIfStatsIfinPkts",
        "description": "PAN-OS packets received on this interface.",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.6",
        "name": "panIfStatsIfoutPkts",
        "description": "PAN-OS packets transmitted on this interface.",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.7",
        "name": "panIfStatsIfinDropPkts",
        "description": "PAN-OS inbound packets dropped on this interface.",
        "unit": "packets",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.8",
        "name": "panIfStatsIfoutDropPkts",
        "description": "PAN-OS outbound packets dropped on this interface.",
        "unit": "packets",
        "data_type": "counter",
    },
    # GlobalProtect
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.5.1.1.1.2",
        "name": "panGPGWCurrentUsers",
        "description": "PAN-OS GlobalProtect Gateway — number of currently connected users.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.25461.2.1.2.5.1.1.1.3",
        "name": "panGPGWUtilizationPct",
        "description": "PAN-OS GlobalProtect Gateway utilization percentage.",
        "unit": "percent",
        "data_type": "gauge",
    },

    # ── Cisco Enterprise MIBs ────────────────────────────────────────────────
    # CISCO-PROCESS-MIB (cpmCPUTotalTable, indexed by Cisco entity index)
    {
        "oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.3.1",
        "name": "cpmCPUTotal5sec",
        "description": "Cisco CPU utilization over the last 5 seconds (first CPU, index 1).",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.4.1",
        "name": "cpmCPUTotal1min",
        "description": "Cisco CPU utilization over the last 1 minute (first CPU, index 1).",
        "unit": "percent",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.5.1",
        "name": "cpmCPUTotal5min",
        "description": "Cisco CPU utilization over the last 5 minutes (first CPU, index 1).",
        "unit": "percent",
        "data_type": "gauge",
    },
    # CISCO-MEMORY-POOL-MIB (ciscoMemoryPoolTable, index 1 = DRAM/processor memory)
    {
        "oid": "1.3.6.1.4.1.9.9.48.1.1.1.5.1",
        "name": "ciscoMemoryPoolUsed",
        "description": "Cisco DRAM memory pool bytes currently in use.",
        "unit": "bytes",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.48.1.1.1.6.1",
        "name": "ciscoMemoryPoolFree",
        "description": "Cisco DRAM memory pool bytes currently free.",
        "unit": "bytes",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.48.1.1.1.8.1",
        "name": "ciscoMemoryPoolLargestFree",
        "description": "Cisco DRAM memory pool — largest contiguous free block in bytes.",
        "unit": "bytes",
        "data_type": "gauge",
    },
    # CISCO-ENVMON-MIB — temperature, fans, power supply
    {
        "oid": "1.3.6.1.4.1.9.9.13.1.3.1.3.1",
        "name": "ciscoEnvMonTemperatureValue",
        "description": "Cisco environmental monitor — current temperature reading (degrees C, sensor index 1).",
        "unit": "Cel",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.13.1.4.1.3.1",
        "name": "ciscoEnvMonFanState",
        "description": "Cisco environmental monitor fan state (1=normal, 2=warning, 3=critical, 4=shutdown, 5=notPresent, 6=notFunctioning).",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.13.1.5.1.3.1",
        "name": "ciscoEnvMonSupplyState",
        "description": "Cisco environmental monitor power supply state (1=normal, 2=warning, 3=critical, 4=shutdown, 5=notPresent, 6=notFunctioning).",
        "unit": "",
        "data_type": "gauge",
    },
    # CISCO-STACK-MIB / VSS — stack member status
    {
        "oid": "1.3.6.1.4.1.9.9.500.1.2.1.1.3.1",
        "name": "cvssSwitchCapabilities",
        "description": "Cisco VSS — Virtual Switching System switch capabilities bitmask.",
        "unit": "",
        "data_type": "gauge",
    },
    # Cisco remote-access VPN sessions (CISCO-REMOTE-ACCESS-MONITOR-MIB)
    {
        "oid": "1.3.6.1.4.1.9.9.392.1.3.1.0",
        "name": "crasNumDeclinedSessions",
        "description": "Cisco ASA/VPN — total number of VPN sessions that were declined.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.4.1.9.9.392.1.3.21.0",
        "name": "crasNumActiveSessions",
        "description": "Cisco ASA/VPN — number of currently active remote-access VPN sessions.",
        "unit": "",
        "data_type": "gauge",
    },

    # ── Additional commonly-polled OIDs ─────────────────────────────────────
    {
        "oid": "1.3.6.1.2.1.4.4.0",
        "name": "ipInHdrErrors",
        "description": "The number of input datagrams discarded due to errors in their IP headers.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.4.5.0",
        "name": "ipInAddrErrors",
        "description": "The number of input datagrams discarded because the IP address in their destination field was not a valid address to be received at this entity.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.4.11.0",
        "name": "ipOutDiscards",
        "description": "The number of output IP datagrams for which no problem was encountered but which were discarded.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.6.0",
        "name": "tcpPassiveOpens",
        "description": "The number of times TCP connections have made a direct transition to the SYN-RCVD state from the LISTEN state.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.7.0",
        "name": "tcpAttemptFails",
        "description": "The number of times TCP connections have made a direct transition to the CLOSED state from either the SYN-SENT or SYN-RCVD state.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.8.0",
        "name": "tcpEstabResets",
        "description": "The number of times TCP connections have made a direct transition to the CLOSED state from either the ESTABLISHED or CLOSE-WAIT state.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.6.9.0",
        "name": "tcpCurrEstab",
        "description": "The number of TCP connections for which the current state is either ESTABLISHED or CLOSE-WAIT.",
        "unit": "",
        "data_type": "gauge",
    },
    {
        "oid": "1.3.6.1.2.1.6.12.0",
        "name": "tcpRetransSegs",
        "description": "The total number of segments retransmitted — that is, the number of TCP segments transmitted containing one or more previously transmitted octets.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.7.2.0",
        "name": "udpNoPorts",
        "description": "The total number of received UDP datagrams for which there was no application at the destination port.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.7.3.0",
        "name": "udpInErrors",
        "description": "The number of received UDP datagrams that could not be delivered for reasons other than the lack of an application at the destination port.",
        "unit": "",
        "data_type": "counter",
    },
    {
        "oid": "1.3.6.1.2.1.25.1.2.0",
        "name": "hrSystemDate",
        "description": "The host's notion of the local date and time of day.",
        "unit": "",
        "data_type": "string",
    },
    {
        "oid": "1.3.6.1.2.1.25.1.6.0",
        "name": "hrSystemProcesses",
        "description": "The number of process contexts currently loaded or running on this system.",
        "unit": "",
        "data_type": "gauge",
    },
]


# ---------------------------------------------------------------------------
# Catalog helpers
# ---------------------------------------------------------------------------

async def seed_catalog(db: aiosqlite.Connection) -> None:
    """INSERT OR IGNORE all BUNDLED_OIDS into the oid_catalog table."""
    for entry in BUNDLED_OIDS:
        await db.execute(
            """
            INSERT OR IGNORE INTO oid_catalog (oid, name, description, unit, data_type, source)
            VALUES (?, ?, ?, ?, ?, 'bundled')
            """,
            (
                entry["oid"],
                entry["name"],
                entry.get("description", ""),
                entry.get("unit", ""),
                entry.get("data_type", "string"),
            ),
        )
    await db.commit()
    log.debug(f"OID catalog seed complete — {len(BUNDLED_OIDS)} entries checked")


async def lookup_oid(db: aiosqlite.Connection, oid: str) -> dict | None:
    """Return the catalog entry for the given OID string, or None if not found."""
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT id, oid, name, description, unit, data_type, source, created_at FROM oid_catalog WHERE oid = ?",
        (oid,),
    ) as cur:
        row = await cur.fetchone()
    return dict(row) if row else None


async def lookup_by_name(db: aiosqlite.Connection, name: str) -> dict | None:
    """Return the catalog entry for the given OID name, or None if not found."""
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT id, oid, name, description, unit, data_type, source, created_at FROM oid_catalog WHERE name = ?",
        (name,),
    ) as cur:
        row = await cur.fetchone()
    return dict(row) if row else None
