# pktSNMP Collector Setup

## Overview

pktSNMP can receive SNMP data from two sources:

1. **Local collector** — built-in, runs in-process on the server at startup. Polls devices assigned to `collector_id=1` using pysnmp. Also listens for raw SNMP traps on UDP 162.
2. **Remote otelcol collectors** — OpenTelemetry Collector instances doing SNMP polling via the native `snmp` receiver, redirected to push OTLP HTTP JSON to pktSNMP's ingest endpoint.

---

## Redirecting otelcol to pktSNMP

Each remote collector needs an OTLP HTTP exporter block added to its config pointing to pktSNMP. The Sync feature in **Settings → Collectors** handles this automatically via SSH — configure the collector's SSH credentials there and click **Sync**.

For manual setup, add the following to your otelcol config:

```yaml
exporters:
  otlphttp/pktsnmp:
    endpoint: "http://<pktsnmp-server>:8767"
    headers:
      Authorization: "Bearer YOUR_COLLECTOR_TOKEN"
    tls:
      insecure: true
```

Add `otlphttp/pktsnmp` to your SNMP pipeline's exporters list, then restart otelcol.

---

## OTLP Metric Format

otelcol's `snmp` receiver produces metrics with names like:

```
SNMP/<SITE>/<DEVICE>/<OID_NAME>
```

Examples:
- `SNMP/DC1/SW1/ifInOctets`
- `SNMP/DC1/FW1/sysUpTime`
- `SNMP/CLOUD/AZ1/ifOperStatus`

pktSNMP parses these by stripping the `SNMP/` prefix and matching the `<SITE>/<DEVICE>` portion against the `otelcol_label` field on each device record. Set `otelcol_label` in **Devices** to match the collector's label exactly.

---

## Collector Token Auth

Each collector has a unique bearer token stored in the `collectors.api_token` column in SQLite. The otelcol config sends it as shown above. Tokens can be rotated from **Settings → Collectors → Rotate Token**, then re-run the Sync or manually update the otelcol config.

---

## SNMP Credentials

Community strings and SNMPv3 credentials are managed in **Settings → Credentials**. Naming convention: `<version>-<collector-name>[-<security-level>]` — e.g. `v2c-site-a`, `v3-datacenter-authPriv`.

- Community strings are stored encrypted at rest and masked in the UI
- The Sync function uses the credential assigned to each device when generating the otelcol receiver config
- Device inline credentials take precedence over the assigned credential (COALESCE: device → credential → default)

---

## Local Collector

The local collector (collector_id=1) is always running. It:
- Polls all devices with `collector_id=1` and `enabled=1` using pysnmp GET
- Listens for SNMP traps on UDP 162 (requires `CAP_NET_BIND_SERVICE` — already set in `pktsnmp.service`)
- Reads its settings from SQLite at startup: `snmp_trap_enabled`, `snmp_poll_enabled`, `snmp_poll_interval_seconds`, `snmp_trap_port`
- **Enabling/disabling the local poll engine does not affect remote otelcol collectors**

To add a device for local polling, go to **Devices → Add Device** and set Collector to `local`.

---

## Adding a New Remote Collector

1. Go to **Settings → Collectors → Add Collector**
2. Enter a name, description, and host IP
3. Copy the generated API token — shown only once
4. Configure SSH credentials under the **SSH** tab
5. Click **Sync** — pktSNMP will SSH to the collector, patch its otelcol config with the correct SNMP receiver blocks, and restart otelcol
6. Add devices in **Devices** with the correct collector and credential assigned

---

## Data Flow

```
otelcol (remote collector)
  └─ snmp receiver (polls devices every N seconds)
  └─ otlphttp/pktsnmp exporter
       └─ POST /api/snmp/ingest/otlp  (bearer token auth)
            └─ parse_otlp_metrics()
            └─ resolve device_id by otelcol_label
            └─ DuckDB: INSERT INTO snmp_poll_results

pysnmp local poller (in-process, local devices only)
  └─ asyncio poll loop → GET per OID per device
       └─ DuckDB: INSERT INTO snmp_poll_results

asyncio trap receiver (UDP 162)
  └─ decode pysnmp trap
       └─ DuckDB: INSERT INTO snmp_traps
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Collector status stays "unknown" | Check the collector is running and the API token matches; verify the OTLP exporter endpoint is reachable |
| No data in DuckDB | `journalctl -u otelcol` on collector host; check pktsnmp.log on server |
| 401 on /ingest/otlp | Token mismatch — rotate token in Settings → Collectors and re-Sync |
| Sync fails | Check SSH credentials in Settings → Collectors → SSH tab; verify the key has access to the collector host |
| Port 162 bind fails | Verify `AmbientCapabilities=CAP_NET_BIND_SERVICE` in pktsnmp.service; `sudo systemctl daemon-reload && sudo systemctl restart pktsnmp` |
| otelcol won't restart after sync | Sync restores backup automatically; check `<config-path>.pktsnmp_bak` on the collector host |
