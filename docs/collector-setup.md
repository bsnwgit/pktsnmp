# pktSNMP Collector Setup

## Overview

pktSNMP can receive SNMP data from two sources:

1. **Local collector** — built-in, runs in-process on O2 at startup. Polls devices assigned to `collector_id=1` using pysnmp. Also listens for raw SNMP traps on UDP 162.
2. **Remote otelcol collectors** — existing OpenTelemetry Collector instances doing SNMP polling via the native `snmp` receiver. Redirected to push OTLP HTTP JSON to pktSNMP's ingest endpoint.

---

## Existing Infrastructure (Vyne)

### Medical Collector
- **Host:** 172.23.80.11 (ec2-user)
- **Service:** `otelcol.service`
- **Config:** `/mnt/software/otel/config/otelcol-config.yaml`
- **Binary:** `/mnt/software/otel/otelcol`
- **Devices polled:** QTS SW1 (v3), QTS FW3/FW4 (v2c), OneNeck SW1/FW1/FW2 (v2c)
- **Pipelines:** `metrics/switch`, `metrics/firewall`

### Dental Collector
- **Host:** 10.56.57.181 (ec2-user)
- **SSH key:** `corporate_infrastructure.pem`
- **Service:** `otelcol.service`
- **Config:** `/mnt/software/otel/config/otelcol-config.yaml`
- **Devices polled:** AWS AZ2A (10.19.56.186), AWS AZ2B (10.19.81.236)
- **Pipeline:** `metrics/firewall`

---

## Redirecting otelcol to pktSNMP

Run the automated scripts (one-time setup, then each time you rotate tokens):

```bash
# On Windows — Python + Paramiko, no ssh.exe
python scripts/update_collector_medical.py
python scripts/update_collector_dental.py
```

Each script:
1. Generates a `secrets.token_urlsafe(32)` bearer token
2. Writes the token to SQLite on O2 (`UPDATE collectors SET api_token=…`)
3. SSHes to the collector host
4. Backs up the current config
5. Injects an `otlphttp/pktsnmp` exporter pointing to `http://172.23.80.5:8767/api/snmp/ingest/otlp`
6. Removes `otlp/openobserve` from the SNMP pipelines
7. Validates the new config (`otelcol validate`)
8. Restarts `otelcol.service`
9. Prints the token (shown once — paste it in Settings → Collectors if needed)

After running, otelcol still exports to OpenObserve for all non-SNMP pipelines. Only the SNMP pipelines are redirected.

---

## OTLP Metric Format

otelcol's `snmp` receiver produces metrics with names like:

```
SNMP/<SITE>/<DEVICE>/<OID_NAME>
```

Examples from medical config:
- `SNMP/QTS/SW1/ifInOctets`
- `SNMP/OneNeck/FW1/sysUpTime`
- `SNMP/QTS/FW3/ifOperStatus`

pktSNMP parses these by stripping the `SNMP/` prefix and matching the `<SITE>/<DEVICE>` portion against the `otelcol_label` field on each device record. Set `otelcol_label` in Settings → Devices to match the collector's label exactly.

---

## Collector Token Auth

Each collector (medical, dental, etc.) has a unique bearer token stored in the `collectors.api_token` column in SQLite. The otelcol config sends it as:

```yaml
exporters:
  otlphttp/pktsnmp:
    endpoint: "http://172.23.80.5:8767"
    headers:
      Authorization: "Bearer <token>"
    tls:
      insecure: true
```

Tokens can be rotated from Settings → Collectors → Rotate Token, then re-run the relevant update script.

---

## Local Collector

The local collector (collector_id=1) is always running. It:
- Polls all devices with `collector_id=1` and `enabled=1` using pysnmp GET
- Listens for SNMP traps on UDP 162 (requires `CAP_NET_BIND_SERVICE` — already set in `pktsnmp.service`)
- Reads its settings from SQLite at startup: `snmp_trap_enabled`, `snmp_poll_enabled`, `snmp_poll_default_interval_seconds`, `snmp_trap_port`

To add a device for local polling, go to Settings → Devices → Add Device and set Collector to `local`.

---

## Adding a New Collector

1. Go to **Settings → Collectors → Add Collector**
2. Enter a name, description, and IP
3. Copy the generated token — it is shown only once
4. Install otelcol on the new host (or configure an existing instance)
5. Add an `otlphttp/pktsnmp` exporter block with the token
6. Add devices in **Settings → Devices** with the correct `collector_id` and `otelcol_label`

### Minimal otelcol exporter config block

```yaml
exporters:
  otlphttp/pktsnmp:
    endpoint: "http://172.23.80.5:8767"
    headers:
      Authorization: "Bearer YOUR_TOKEN_HERE"
    tls:
      insecure: true
```

Add `otlphttp/pktsnmp` to your SNMP pipeline's exporters list.

---

## Data Flow

```
otelcol (medical/dental)
  └─ snmp receiver (polls devices every N seconds)
  └─ otlphttp/pktsnmp exporter
       └─ POST /api/snmp/ingest/otlp  (bearer token auth)
            └─ parse_otlp_metrics()
            └─ resolve device_id by otelcol_label
            └─ DuckDB: INSERT INTO snmp_poll_results

pysnmp local poller (O2, in-process)
  └─ asyncio poll loop → GET per OID per device
       └─ DuckDB: INSERT INTO snmp_poll_results

asyncio trap receiver (O2, UDP 162)
  └─ decode pysnmp trap
       └─ DuckDB: INSERT INTO snmp_traps
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Collector status stays "unknown" | Run update script; verify token in SQLite matches otelcol config |
| No data in DuckDB | `journalctl -u otelcol` on collector; check pktsnmp.log on O2 |
| 401 on /ingest/otlp | Token mismatch — rotate token and re-run update script |
| Port 162 bind fails | Verify `AmbientCapabilities=CAP_NET_BIND_SERVICE` in pktsnmp.service; `sudo systemctl daemon-reload && sudo systemctl restart pktsnmp` |
| otelcol won't restart after update | Script restores backup automatically; check `/mnt/software/otel/config/otelcol-config.yaml.bak` |
