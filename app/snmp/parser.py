"""
SNMP data parsers — OTLP JSON from otelcol and raw pysnmp traps.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("pktsnmp.snmp.parser")


def parse_otlp_metrics(body: dict, collector_id: int) -> list[dict]:
    """
    Parse OTLP HTTP JSON from otelcol snmp receiver.

    Metric name format: "SNMP/<SITE>/<DEVICE>/<OID_LABEL>"
    e.g. "SNMP/QTS/SW1/ifInOctets"

    Returns list of normalized poll result dicts.
    """
    results: list[dict] = []
    try:
        for rm in body.get("resourceMetrics", []):
            for sm in rm.get("scopeMetrics", []):
                for metric in sm.get("metrics", []):
                    name = metric.get("name", "")
                    if not name.startswith("SNMP/"):
                        continue

                    # Parse name: strip "SNMP/", split remainder
                    parts = name[5:].split("/")  # e.g. ["QTS", "SW1", "ifInOctets"]
                    if len(parts) < 2:
                        continue
                    oid_label = parts[-1]
                    device_label = "/".join(parts[:-1])  # e.g. "QTS/SW1"

                    # Determine value type and data points
                    value_type = "gauge"
                    data_points: list[dict] = []
                    if "sum" in metric:
                        value_type = "counter"
                        data_points = metric["sum"].get("dataPoints", [])
                    elif "gauge" in metric:
                        value_type = "gauge"
                        data_points = metric["gauge"].get("dataPoints", [])

                    for dp in data_points:
                        # Extract timestamp
                        ts_nano = dp.get("timeUnixNano", "0")
                        try:
                            ts_sec = int(ts_nano) / 1e9
                            timestamp = datetime.fromtimestamp(ts_sec, tz=timezone.utc).isoformat()
                        except Exception:
                            timestamp = datetime.now(tz=timezone.utc).isoformat()

                        # Extract value
                        raw_value: str | None = None
                        value_numeric: float | None = None
                        if "asInt" in dp:
                            raw_value = str(dp["asInt"])
                            try:
                                value_numeric = float(dp["asInt"])
                            except (ValueError, TypeError):
                                pass
                        elif "asDouble" in dp:
                            raw_value = str(dp["asDouble"])
                            try:
                                value_numeric = float(dp["asDouble"])
                            except (ValueError, TypeError):
                                pass

                        # Extract attributes
                        attributes: dict[str, Any] = {}
                        for attr in dp.get("attributes", []):
                            k = attr.get("key", "")
                            v_obj = attr.get("value", {})
                            if "stringValue" in v_obj:
                                attributes[k] = v_obj["stringValue"]
                            elif "intValue" in v_obj:
                                attributes[k] = v_obj["intValue"]
                            elif "doubleValue" in v_obj:
                                attributes[k] = v_obj["doubleValue"]
                            elif "boolValue" in v_obj:
                                attributes[k] = v_obj["boolValue"]

                        # Extract interface label from otelcol column_oids attributes.
                        # IF-MIB metrics attach ifDescr/ifName; PAN-OS panIfStats
                        # metrics attach panIfStatsIfname instead.
                        iface_label: str | None = (
                            attributes.get("ifDescr")
                            or attributes.get("ifName")
                            or attributes.get("panIfStatsIfname")
                            or None
                        )

                        results.append(
                            {
                                "collector_id": collector_id,
                                "device_label": device_label,
                                "oid_label": oid_label,
                                "value": raw_value,
                                "value_numeric": value_numeric,
                                "value_type": value_type,
                                "timestamp": timestamp,
                                "attributes": attributes,
                                "interface_label": iface_label,
                            }
                        )
    except Exception as e:
        log.error(f"OTLP parse error: {e}")

    return results


def parse_trap_payload(trap_dict: dict) -> dict:
    """
    Normalize a pysnmp trap dict (from TrapReceiver) into storage format.
    trap_dict keys: source_ip, community, version, varbinds (list of {oid, value, type})
    """
    return {
        "source_ip": trap_dict.get("source_ip", ""),
        "snmp_version": trap_dict.get("version", "v2c"),
        "community": trap_dict.get("community", ""),
        "trap_oid": trap_dict.get("trap_oid", ""),
        "varbinds": trap_dict.get("varbinds", []),
        "device_id": None,  # resolved later by caller
        "collector_id": trap_dict.get("collector_id", 1),
    }
