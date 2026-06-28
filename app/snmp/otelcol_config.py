"""
otelcol_config.py — Generate otelcol YAML receiver blocks for SNMP devices.

Produces the `receivers` and `service.pipelines` sections that map to
devices stored in pktSNMP's SQLite devices table. The output is used by
collector_push.py to patch a live otelcol config.

Standard IF-MIB metric set (12 metrics per device):
  Gauges:  Network/Status, ifAdminStatusMetric, ifOperStatusMetric, ifSpeedMetric
  Sums:    ifInOctets, ifInUcastPkts, ifInDiscards, ifInErrors,
           ifOutOctets, ifOutUcastPkts, ifOutDiscards, ifOutErrors

All metrics use column_oids with ifDescr / ifType / ifName attributes so
that per-interface rows are distinguishable in the time-series data.
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

# Attribute list attached to every column_oid entry
_COL_ATTRS = [{"name": "ifDescr"}, {"name": "ifType"}, {"name": "ifName"}]

# ── Metric template ───────────────────────────────────────────────────────────

def _gauge(oid: str, description: str, unit: str) -> dict:
    return {
        "column_oids": [{"attributes": _COL_ATTRS, "oid": oid}],
        "description": description,
        "gauge": {"value_type": "int"},
        "unit": unit,
    }


def _sum(oid: str, description: str, unit: str) -> dict:
    return {
        "column_oids": [{"attributes": _COL_ATTRS, "oid": oid}],
        "description": description,
        "sum": {
            "aggregation_temporality": "cumulative",
            "mono": True,
            "value_type": "int",
        },
        "unit": unit,
    }


def _metrics_for_label(label: str) -> dict:
    """Return the 12-metric dict keyed by 'SNMP/<label>/<suffix>'."""
    pfx = f"SNMP/{label}"
    return {
        f"{pfx}/Network/Status":      _gauge("1.3.6.1.2.1.2.2.1.8", "Network Interface Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifAdminStatusMetric": _gauge("1.3.6.1.2.1.2.2.1.7", "Admin Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifOperStatusMetric":  _gauge("1.3.6.1.2.1.2.2.1.8", "Operational Status (1=Up, 2=Down)", "state"),
        f"{pfx}/ifSpeedMetric":       _gauge("1.3.6.1.2.1.2.2.1.5", "Interface Speed", "bit/s"),
        f"{pfx}/ifInOctets":          _sum("1.3.6.1.2.1.2.2.1.10", "Inbound Octets", "By"),
        f"{pfx}/ifInUcastPkts":       _sum("1.3.6.1.2.1.2.2.1.11", "Inbound Unicast Packets", "{packet}"),
        f"{pfx}/ifInDiscards":        _sum("1.3.6.1.2.1.2.2.1.13", "Inbound Discarded Packets", "{packet}"),
        f"{pfx}/ifInErrors":          _sum("1.3.6.1.2.1.2.2.1.14", "Inbound Error Packets", "{packet}"),
        f"{pfx}/ifOutOctets":         _sum("1.3.6.1.2.1.2.2.1.16", "Outbound Octets", "By"),
        f"{pfx}/ifOutUcastPkts":      _sum("1.3.6.1.2.1.2.2.1.17", "Outbound Unicast Packets", "{packet}"),
        f"{pfx}/ifOutDiscards":       _sum("1.3.6.1.2.1.2.2.1.19", "Outbound Discarded Packets", "{packet}"),
        f"{pfx}/ifOutErrors":         _sum("1.3.6.1.2.1.2.2.1.20", "Outbound Error Packets", "{packet}"),
    }


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
                   poll_interval_override).
    *credential* — row from snmp_credentials (or None for default v2c public).
                   Secret key values must already be decrypted (plain text).
    """
    label = device.get("otelcol_label") or device.get("name", "unknown")

    cred = credential or {}
    version = cred.get("snmp_version") or "v2c"

    interval_s = device.get("poll_interval_override") or 60
    interval = f"{interval_s}s"

    ip = device.get("ip", "")

    block: dict[str, Any] = {
        "attributes":           dict(_IF_ATTRIBUTES),
        "collection_interval":  interval,
        "endpoint":             f"udp://{ip}:161",
        "metrics":              _metrics_for_label(label),
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
        - all device columns (otelcol_label, ip, poll_interval_override, …)
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

    # Add new snmp/* receivers to their target pipelines
    for pipeline_name, rnames in pipeline_map.items():
        if pipeline_name not in pipelines:
            # Create a minimal pipeline definition
            # Copy exporter/processor refs from first existing pipeline
            first = next(iter(pipelines.values()), {})
            pipelines[pipeline_name] = {
                "exporters":  list(first.get("exporters", [])),
                "processors": list(first.get("processors", [])),
                "receivers":  [],
            }
        existing_r = pipelines[pipeline_name].get("receivers") or []
        for r in rnames:
            if r not in existing_r:
                existing_r.append(r)
        pipelines[pipeline_name]["receivers"] = existing_r

    # Prune empty pipelines (only if they now have zero receivers AND were snmp-only before)
    # Keep all original pipelines intact — only remove ones we created that are empty.
    return cfg


def config_to_yaml(cfg: dict) -> str:
    """Serialize config dict to YAML string."""
    import yaml
    return yaml.dump(cfg, default_flow_style=False, allow_unicode=True, sort_keys=False)
