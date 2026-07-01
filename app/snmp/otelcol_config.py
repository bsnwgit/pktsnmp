"""
otelcol_config.py — Generate otelcol YAML receiver blocks for SNMP devices.

Produces the `receivers` and `service.pipelines` sections that map to
devices stored in pktSNMP's SQLite devices table. The output is used by
collector_push.py to patch a live otelcol config.

Standard IF-MIB metric set (all devices):
  Gauges:  Network/Status, ifAdminStatusMetric, ifOperStatusMetric, ifSpeedMetric
  Sums:    ifInOctets, ifInUcastPkts, ifInDiscards, ifInErrors,
           ifOutOctets, ifOutUcastPkts, ifOutDiscards, ifOutErrors

64-bit HC counters added for all devices (ifXTable):
  ifHCInOctets, ifHCOutOctets, ifHCInUcastPkts, ifHCOutUcastPkts

PAN-OS extras (device_type == "firewall"):
  Scalars: panSysCpuUtilMgmt, panSysCpuUtilDataPlane, panSysMemUsed,
           panSysMemAvail, panSessionUtilization, panSessionMax,
           panSessionActive, panSessionActiveTcp, panSessionActiveUdp,
           panSessionActiveICMP
  Table:   panIfInBytes, panIfOutBytes, panIfInPkts, panIfOutPkts,
           panIfInDropPkts, panIfOutDropPkts  (via panIfStatsTable)

Cisco extras (device_type in {"switch", "router"}):
  Scalars: cpmCPUTotal5sec, cpmCPUTotal1min, cpmCPUTotal5min,
           ciscoMemPoolUsed, ciscoMemPoolFree, ciscoMemPoolLargest
"""
from __future__ import annotations

from typing import Any

# ── IF-MIB attribute OIDs (same block on every receiver) ─────────────────────

_IF_ATTRIBUTES = {
    "ifAdminStatus": {"oid": "1.3.6.1.2.1.2.2.1.7"},
    "ifDescr":       {"oid": "1.3.6.1.2.1.2.2.1.2"},
    "ifIndex":       {"oid": "1.3.6.1.2.1.2.2.1.1"},
    "ifMtu":         {"oid": "1.3.6.1.2.1.2.2.1.4"},
    "ifName":        {"oid": "1.3.6.1.2.1.31.1.1.1.1"},
    "ifOperStatus":  {"oid": "1.3.6.1.2.1.2.2.1.8"},
    "ifPhysAddress": {"oid": "1.3.6.1.2.1.2.2.1.6"},
    "ifSpeed":       {"oid": "1.3.6.1.2.1.2.2.1.5"},
    "ifType":        {"oid": "1.3.6.1.2.1.2.2.1.3"},
}

# Attribute list attached to IF-MIB column_oid entries
_COL_ATTRS = [{"name": "ifDescr"}, {"name": "ifType"}, {"name": "ifName"}]

# ── PAN-OS attribute OIDs ─────────────────────────────────────────────────────

# panIfStatsTable column 1 (Ifname) — used to identify each row by interface name.
# Table is indexed by OCTET STRING (interface name), so otelcol walks the column
# and attaches the string as an attribute to correlate with metric columns .3/.4/etc.
_PAN_ATTRIBUTES = {
    "panIfStatsIfname": {"oid": "1.3.6.1.4.1.25461.2.1.2.4.1.1.1"},
}

# Attribute list for PAN panIfStats column_oid entries
_PAN_COL_ATTRS = [{"name": "panIfStatsIfname"}]

# ── Metric templates ──────────────────────────────────────────────────────────

def _gauge(oid: str, description: str, unit: str) -> dict:
    """IF-MIB column gauge — per-interface, walks ifTable."""
    return {
        "column_oids": [{"attributes": _COL_ATTRS, "oid": oid}],
        "description": description,
        "gauge": {"value_type": "int"},
        "unit": unit,
    }


def _sum(oid: str, description: str, unit: str) -> dict:
    """IF-MIB column sum — per-interface, walks ifTable."""
    return {
        "column_oids": [{"attributes": _COL_ATTRS, "oid": oid}],
        "description": description,
        "sum": {
            "aggregation": "cumulative",
            "monotonic": True,
            "value_type": "int",
        },
        "unit": unit,
    }


def _scalar_gauge(oid: str, description: str, unit: str) -> dict:
    """Scalar gauge — single OID (no table walk)."""
    return {
        "scalar_oids": [{"oid": oid}],
        "description": description,
        "gauge": {"value_type": "int"},
        "unit": unit,
    }


def _pan_sum(oid: str, description: str, unit: str) -> dict:
    """PAN panIfStats column sum — per-interface, walks panIfStatsTable."""
    return {
        "column_oids": [{"attributes": _PAN_COL_ATTRS, "oid": oid}],
        "description": description,
        "sum": {
            "aggregation": "cumulative",
            "monotonic": True,
            "value_type": "int",
        },
        "unit": unit,
    }


# ── Metric sets by category ───────────────────────────────────────────────────

def _if_mib_metrics(label: str) -> dict:
    """Standard IF-MIB 12-metric set — all devices."""
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/Network/Status":      _gauge("1.3.6.1.2.1.2.2.1.8", "Network Interface Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifAdminStatusMetric": _gauge("1.3.6.1.2.1.2.2.1.7", "Admin Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifOperStatusMetric":  _gauge("1.3.6.1.2.1.2.2.1.8", "Operational Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifSpeedMetric":       _gauge("1.3.6.1.2.1.2.2.1.5", "Interface Speed", "bit/s"),
        f"{pfx}/ifInOctets":          _sum("1.3.6.1.2.1.2.2.1.10",  "Inbound Octets (32-bit)", "By"),
        f"{pfx}/ifInUcastPkts":       _sum("1.3.6.1.2.1.2.2.1.11",  "Inbound Unicast Packets", "{packet}"),
        f"{pfx}/ifInDiscards":        _sum("1.3.6.1.2.1.2.2.1.13",  "Inbound Discarded Packets", "{packet}"),
        f"{pfx}/ifInErrors":          _sum("1.3.6.1.2.1.2.2.1.14",  "Inbound Error Packets", "{packet}"),
        f"{pfx}/ifOutOctets":         _sum("1.3.6.1.2.1.2.2.1.16",  "Outbound Octets (32-bit)", "By"),
        f"{pfx}/ifOutUcastPkts":      _sum("1.3.6.1.2.1.2.2.1.17",  "Outbound Unicast Packets", "{packet}"),
        f"{pfx}/ifOutDiscards":       _sum("1.3.6.1.2.1.2.2.1.19",  "Outbound Discarded Packets", "{packet}"),
        f"{pfx}/ifOutErrors":         _sum("1.3.6.1.2.1.2.2.1.20",  "Outbound Error Packets", "{packet}"),
    }


def _if_hc_metrics(label: str) -> dict:
    """64-bit HC counters from ifXTable — all devices.

    Supplement the 32-bit ifInOctets/ifOutOctets on high-speed links.
    Uses the same _COL_ATTRS (ifDescr/ifName) as standard IF-MIB metrics.
    """
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/ifHCInOctets":    _sum("1.3.6.1.2.1.31.1.1.1.6",  "Inbound Octets (64-bit)", "By"),
        f"{pfx}/ifHCOutOctets":   _sum("1.3.6.1.2.1.31.1.1.1.10", "Outbound Octets (64-bit)", "By"),
        f"{pfx}/ifHCInUcastPkts": _sum("1.3.6.1.2.1.31.1.1.1.7",  "Inbound Unicast Packets (64-bit)", "{packet}"),
        f"{pfx}/ifHCOutUcastPkts":_sum("1.3.6.1.2.1.31.1.1.1.11", "Outbound Unicast Packets (64-bit)", "{packet}"),
    }


def _pan_if_metrics(label: str) -> dict:
    """PAN-OS per-interface traffic counters (panIfStatsTable).

    panIfStatsTable is indexed by interface name (OCTET STRING), so otelcol
    walks the panIfStatsIfname attribute column to get the interface name for
    each row and attaches it as 'panIfStatsIfname'. The parser then picks this
    up as interface_label so these metrics group correctly by interface.

    Base OID: 1.3.6.1.4.1.25461.2.1.2.4.1.1.*
    """
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/panIfInBytes":     _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.3", "PAN-OS Interface Inbound Bytes",           "By"),
        f"{pfx}/panIfOutBytes":    _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.4", "PAN-OS Interface Outbound Bytes",          "By"),
        f"{pfx}/panIfInPkts":      _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.5", "PAN-OS Interface Inbound Packets",         "{packet}"),
        f"{pfx}/panIfOutPkts":     _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.6", "PAN-OS Interface Outbound Packets",        "{packet}"),
        f"{pfx}/panIfInDropPkts":  _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.7", "PAN-OS Interface Inbound Dropped Packets", "{packet}"),
        f"{pfx}/panIfOutDropPkts": _pan_sum("1.3.6.1.4.1.25461.2.1.2.4.1.1.8", "PAN-OS Interface Outbound Dropped Packets","{packet}"),
    }


def _pan_scalar_metrics(label: str) -> dict:
    """PAN-OS system-level scalar OIDs — CPU, memory, session table.

    These are scalar (no table walk). The OIDs include the .0 instance suffix.
    """
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/panSysCpuUtilMgmt":      _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.1.10.0", "PAN-OS Management CPU Utilization",    "%"),
        f"{pfx}/panSysCpuUtilDataPlane": _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.1.11.0", "PAN-OS Data Plane CPU Utilization",    "%"),
        f"{pfx}/panSysMemUsed":          _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.1.14.0", "PAN-OS Memory Used",                   "KiBy"),
        f"{pfx}/panSysMemAvail":         _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.1.15.0", "PAN-OS Memory Available",              "KiBy"),
        f"{pfx}/panSessionUtilization":  _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.2.0",  "PAN-OS Session Table Utilization",     "%"),
        f"{pfx}/panSessionMax":          _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.3.0",  "PAN-OS Maximum Sessions",              "{session}"),
        f"{pfx}/panSessionActive":       _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.4.0",  "PAN-OS Active Sessions",               "{session}"),
        f"{pfx}/panSessionActiveTcp":    _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.5.0",  "PAN-OS Active TCP Sessions",           "{session}"),
        f"{pfx}/panSessionActiveUdp":    _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.6.0",  "PAN-OS Active UDP Sessions",           "{session}"),
        f"{pfx}/panSessionActiveICMP":   _scalar_gauge("1.3.6.1.4.1.25461.2.1.2.3.7.0",  "PAN-OS Active ICMP Sessions",          "{session}"),
    }


def _cisco_scalar_metrics(label: str) -> dict:
    """Cisco IOS/IOS-XE/NX-OS system-level scalars — CPU, memory, environment.

    CPU OIDs use index .1 (first/only CPU entity).
    Memory OIDs use index .1 (DRAM/processor pool).
    These are polled as scalar_oids (specific instance, no walk).
    """
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/cpmCPUTotal5sec":     _scalar_gauge("1.3.6.1.4.1.9.9.109.1.1.1.1.3.1", "Cisco CPU Utilization 5-second",        "%"),
        f"{pfx}/cpmCPUTotal1min":     _scalar_gauge("1.3.6.1.4.1.9.9.109.1.1.1.1.4.1", "Cisco CPU Utilization 1-minute",        "%"),
        f"{pfx}/cpmCPUTotal5min":     _scalar_gauge("1.3.6.1.4.1.9.9.109.1.1.1.1.5.1", "Cisco CPU Utilization 5-minute",        "%"),
        f"{pfx}/ciscoMemPoolUsed":    _scalar_gauge("1.3.6.1.4.1.9.9.48.1.1.1.5.1",    "Cisco DRAM Memory Pool Used",           "By"),
        f"{pfx}/ciscoMemPoolFree":    _scalar_gauge("1.3.6.1.4.1.9.9.48.1.1.1.6.1",    "Cisco DRAM Memory Pool Free",           "By"),
        f"{pfx}/ciscoMemPoolLargest": _scalar_gauge("1.3.6.1.4.1.9.9.48.1.1.1.8.1",    "Cisco DRAM Memory Largest Free Block",  "By"),
    }


def _metrics_for_label(label: str, device_type: str | None = None) -> dict:
    """Return the full metrics dict for a device, with vendor-specific extras.

    All devices get the 12 standard IF-MIB metrics + 4 HC 64-bit counters.
    Firewalls (PAN-OS) get panIfStats per-interface table + 10 scalar OIDs.
    Switches/routers (Cisco) get 6 Cisco CPU/memory scalars.
    """
    metrics: dict = {}
    metrics.update(_if_mib_metrics(label))
    metrics.update(_if_hc_metrics(label))

    dt = (device_type or "").lower()
    if dt == "firewall":
        metrics.update(_pan_if_metrics(label))
        metrics.update(_pan_scalar_metrics(label))
    elif dt in ("switch", "router"):
        metrics.update(_cisco_scalar_metrics(label))

    return metrics


# ── Security-level normalisation ──────────────────────────────────────────────

def _otelcol_security_level(level: str | None) -> str:
    """Map pktSNMP security_level names → otelcol names."""
    mapping = {
        "noAuthNoPriv": "no_auth_no_priv",
        "authNoPriv":   "auth_no_priv",
        "authPriv":     "auth_priv",
    }
    return mapping.get(level or "noAuthNoPriv", "no_auth_no_priv")


def _otelcol_auth_type(proto: str | None) -> str:
    """Map pktSNMP auth_protocol → otelcol auth_type (short form)."""
    if not proto:
        return "SHA"
    if "256" in proto:
        return "SHA256"
    if "384" in proto:
        return "SHA384"
    if "512" in proto:
        return "SHA512"
    if "MD5" in proto.upper():
        return "MD5"
    return "SHA"


# ── Public: receiver block builder ────────────────────────────────────────────

def build_receiver_block(device: dict, credential: dict | None) -> dict:
    """
    Build a single otelcol SNMP receiver block dict for *device*.

    *device*     — row from the devices table (must include otelcol_label, ip,
                   poll_interval_override, device_type).
    *credential* — row from snmp_credentials (or None for default v2c public).
                   Secret key values must already be decrypted (plain text).
    """
    label = device.get("otelcol_label") or device.get("name", "unknown")
    device_type = (device.get("device_type") or "").lower()

    cred = credential or {}
    version = cred.get("snmp_version") or "v2c"

    interval_s = device.get("poll_interval_override") or 60
    interval = f"{interval_s}s"

    ip = device.get("ip", "")

    # Build attributes dict — always include IF-MIB attrs; add PAN attrs for firewalls
    attributes: dict = dict(_IF_ATTRIBUTES)
    if device_type == "firewall":
        attributes.update(_PAN_ATTRIBUTES)

    block: dict[str, Any] = {
        "attributes":           attributes,
        "collection_interval":  interval,
        "endpoint":             f"udp://{ip}:161",
        "metrics":              _metrics_for_label(label, device_type),
        "version":              version,
    }

    if version == "v2c" or version == "v1":
        block["community"] = cred.get("community") or "public"
    else:
        # v3
        block["user"]           = cred.get("security_name") or ""
        block["security_level"] = _otelcol_security_level(cred.get("security_level"))
        auth_key = cred.get("auth_key") or ""
        if auth_key:
            block["auth_password"] = auth_key
            block["auth_type"]     = _otelcol_auth_type(cred.get("auth_protocol"))
        priv_key = cred.get("priv_key") or ""
        if priv_key:
            block["priv_password"] = priv_key
            block["priv_type"]     = "AES128"   # default; can be extended

    return block


def receiver_name(otelcol_label: str) -> str:
    """Return the otelcol receiver key for a device label, e.g. 'QTS/FW3' → 'snmp/qts/fw3'."""
    return "snmp/" + otelcol_label.lower()


# ── Public: full config patcher ───────────────────────────────────────────────

def patch_config(
    existing_config: dict,
    devices_with_creds: list[dict],
) -> dict:
    """
    Patch *existing_config* (a parsed YAML dict) to reflect current *devices*.

    The function:
    1. Removes all receiver keys that start with 'snmp/'.
    2. Injects new snmp/* receiver blocks from devices_with_creds.
    3. For each pipeline in service.pipelines, removes old snmp/* receiver
       refs and adds new ones grouped by device.otelcol_pipeline.
    4. Returns the patched config dict (caller must serialize + upload).

    *devices_with_creds* — list of dicts, each with:
        - all device columns (otelcol_label, ip, poll_interval_override,
          device_type, …)
        - 'auth_key' / 'priv_key' as PLAIN TEXT (caller decrypts before passing)
        - 'snmp_version', 'community', 'security_name', 'security_level',
          'auth_protocol' from the credential row (or None)
        - 'otelcol_pipeline' — pipeline name this device belongs to
    """
    import copy
    cfg = copy.deepcopy(existing_config)

    # ── 1. Ensure sections exist ──────────────────────────────────────────────
    cfg.setdefault("receivers", {})
    cfg.setdefault("service", {}).setdefault("pipelines", {})

    # ── 2. Remove old snmp/* receivers ───────────────────────────────────────
    old_keys = [k for k in cfg["receivers"] if k.startswith("snmp/")]
    for k in old_keys:
        del cfg["receivers"][k]

    # ── 3. Build new receiver blocks ─────────────────────────────────────────
    # pipeline_map: pipeline_name → list of receiver names
    pipeline_map: dict[str, list[str]] = {}
    for dev in devices_with_creds:
        label = dev.get("otelcol_label")
        if not label:
            continue
        rname = receiver_name(label)
        cfg["receivers"][rname] = build_receiver_block(dev, dev)
        pipeline = dev.get("otelcol_pipeline") or "metrics/snmp"
        pipeline_map.setdefault(pipeline, []).append(rname)

    # ── 4. Patch pipelines ────────────────────────────────────────────────────
    pipelines = cfg["service"]["pipelines"]

    # Remove all snmp/* refs from existing pipelines
    for pname, pdef in pipelines.items():
        if isinstance(pdef, dict) and "receivers" in pdef:
            pdef["receivers"] = [
                r for r in (pdef["receivers"] or [])
                if not str(r).startswith("snmp/")
            ]

    # Find the pktsnmp exporter key — must be in the exporters section
    pktsnmp_exporter = next(
        (k for k in cfg.get("exporters", {}) if "pktsnmp" in k),
        "otlphttp/pktsnmp",  # safe default if not yet defined
    )

    # Add new snmp/* receivers to their target pipelines
    for pipeline_name, rnames in pipeline_map.items():
        if pipeline_name not in pipelines:
            # Create a new pipeline using the pktsnmp exporter — NOT copying
            # the first existing pipeline (which may be a logs/cert or other
            # non-SNMP pipeline with a completely wrong exporter).
            pipelines[pipeline_name] = {
                "exporters":  [pktsnmp_exporter],
                "processors": ["batch"],
                "receivers":  [],
            }
        existing_r = pipelines[pipeline_name].get("receivers") or []
        for r in rnames:
            if r not in existing_r:
                existing_r.append(r)
        pipelines[pipeline_name]["receivers"] = existing_r

    # Remove any pipeline that ended up with no receivers after the cleanup.
    # This handles stale pipelines left over from a previous sync (e.g. a
    # metrics/firewall pipeline whose devices were re-classified or removed).
    stale = [
        pname for pname, pdef in list(pipelines.items())
        if not (pdef.get("receivers") or [])
    ]
    for pname in stale:
        del pipelines[pname]

    return cfg


def config_to_yaml(cfg: dict) -> str:
    """Serialize config dict to YAML string."""
    import yaml
    return yaml.dump(cfg, default_flow_style=False, allow_unicode=True, sort_keys=False)
