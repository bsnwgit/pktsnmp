# pktSNMP

SNMP ingest management and visualization platform — part of the pkt suite. Receives SNMP data from remote otelcol collectors and local devices, stores it in SQLite (or ClickHouse/DuckDB), and surfaces it through a React UI with real-time alerting and an AI assistant.

**Default port:** `8767` (HTTP) — see [SSL/TLS](#ssltls) for HTTPS.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Frontend Build & Deploy](#frontend-build--deploy)
- [Collector Setup](#collector-setup)
- [Configuration Reference](#configuration-reference)
- [Running & Managing the Service](#running--managing-the-service)
- [Upgrading](#upgrading)
- [Roles & Auth](#roles--auth)
- [SNMP Settings](#snmp-settings)
- [SSL/TLS](#ssltls)
- [Alert Engine](#alert-engine)
- [Device Hierarchy](#device-hierarchy)
- [Database Backends](#database-backends)
- [Backup & Restore](#backup--restore)
- [pktHub Integration](#pkthub-integration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick Start

```bash
# 1. Clone the repository
git clone git@github.com:bsnwgit/pktsnmp.git
cd pktsnmp

# 2. Run the installer — prompts for an install directory (default /opt/pktsnmp),
#    then handles system packages, Python venv, config.yaml + secret key, DB
#    migrations, admin user, frontend build (if npm is present), and the
#    systemd service (installed + started)
bash install.sh

# Prints the admin password at the end — save it, it is not shown again.

# 3. Open the firewall for the app port (adjust if PKTSNMP_INSTALL_DIR/port differ)
sudo ufw allow 8767/tcp
sudo ufw allow 162/udp   # only if using the built-in SNMP trap receiver

# 4. Open http://<server-ip>:8767 and log in with the admin credentials from step 2
```

### Environment variables

`install.sh` honors the following overrides:

| Variable | Default | Description |
|---|---|---|
| `PKTSNMP_INSTALL_DIR` | `/opt/pktsnmp` | Where the app, venv, and config are installed |
| `PKTSNMP_LOG_DIR` | `$PKTSNMP_INSTALL_DIR/logs` | Log file directory |
| `PKTSNMP_SERVICE_USER` | current user | User the systemd service runs as |
| `PKTSNMP_SERVICE_GROUP` | `$PKTSNMP_SERVICE_USER` | Group the systemd service runs as |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     pktSNMP host                              │
│                                                              │
│   pktsnmp.service  (uvicorn / FastAPI)  :8767                │
│   ├── REST API  (app/api/)                                   │
│   ├── SNMP trap receiver  (UDP 162, asyncio)                 │
│   ├── Local poll engine   (pysnmp, asyncio)                  │
│   ├── Alert engine        (60s loop, fires + resolves)       │
│   └── AI assistant        (Anthropic)                        │
│                                                              │
│   SQLite  pktsnmp.db          ← settings, users, devices,    │
│                                  collectors, alert rules,     │
│                                  alert events, notif log      │
│   SQLite  snmp_timeseries.db  ← snmp_traps, snmp_poll_results│
│   (or DuckDB / ClickHouse — switchable in Settings → Storage) │
│                                                              │
│   React SPA  frontend/dist/                                  │
│   served by uvicorn StaticFiles                              │
└──────────────────────────────────────────────────────────────┘
         ▲                        ▲
         │ OTLP HTTP              │ SNMP trap (UDP 162)
         │                        │
┌────────────────┐      ┌─────────────────────┐
│ otelcol        │      │ Network devices      │
│ collector(s)   │      │ (routers, switches,  │
│                │      │  firewalls)          │
└────────────────┘      └─────────────────────┘
```

### Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + aiosqlite (Python 3.11+) |
| App database | SQLite `pktsnmp.db` (settings, devices, alerts) |
| Time-series store | SQLite `snmp_timeseries.db` (default) or DuckDB / ClickHouse |
| Frontend | React 18 + TypeScript + Tailwind CSS + Vite |
| Auth | JWT (15 min) + httpOnly refresh (7 days) + Okta SAML 2.0 |
| SNMP | pysnmp-lextudio (v1/v2c/v3 traps and polling) |
| Service | systemd `pktsnmp.service` |

---

## Requirements

- Ubuntu Server 22.04 or 24.04 LTS
- Python 3.11+
- Node.js 20+ (for building the frontend — see [Frontend Build & Deploy](#frontend-build--deploy))
- `sudo` access (installer creates the install directory, a systemd unit, and installs apt packages)

The installer (`install.sh`) installs the remaining system packages: `libssl-dev`, `libffi-dev` (for `cryptography`), and `libxmlsec1-dev`, `libxmlsec1-openssl`, `libxml2-dev`, `pkg-config`, `gcc` (for `python3-saml`, used by Okta SAML SSO).

Optional: ClickHouse, if you plan to switch the time-series storage backend for very high-volume environments (see [Database Backends](#database-backends)). Not required for a default install.

---

## Installation

### 1 — Clone the repository

```bash
git clone git@github.com:bsnwgit/pktsnmp.git
cd pktsnmp
```

### 2 — Run the installer

```bash
bash install.sh
```

Prompts for an install directory (default `/opt/pktsnmp`) if run interactively; set `PKTSNMP_INSTALL_DIR` to skip the prompt (see [Environment variables](#environment-variables)). Performs, in order:

1. Installs system packages (Python, build tools, `libssl-dev`/`libffi-dev`, `libxmlsec1`/`libxml2` for SAML)
2. Creates the install directory and log directory
3. Creates a Python virtualenv and installs `requirements.txt`
4. Copies `app/` and `migrations/` into the install directory (skipped if installing in-place, i.e. the install directory is the repo checkout itself)
5. Creates `config.yaml` from `config.example.yaml`, generating a random `secret_key` and pinning `install_dir` — every other on-disk path (`db_path`, `duckdb_path`, `log_file`, `ssl_dir`, backups) defaults to somewhere under `install_dir` unless explicitly overridden
6. Applies database migrations and creates the initial `admin` user (prints the generated password once)
7. Builds and deploys the frontend automatically if `npm` is on `PATH`; otherwise prints the exact manual build command to run afterward — see [Frontend Build & Deploy](#frontend-build--deploy)
8. Installs and starts the `pktsnmp` systemd service (substituting install dir / log dir / user / group into the unit template)

### 3 — Open the firewall

```bash
sudo ufw allow 8767/tcp
sudo ufw allow 162/udp   # only if using the built-in SNMP trap receiver
```

### 4 — Verify and log in

```bash
sudo systemctl status pktsnmp
curl -s http://localhost:8767/api/health
```

Navigate to `http://<server-ip>:8767` and log in with the admin credentials printed by the installer. **Change the password immediately** in Settings → Users.

### Re-running the installer

`install.sh` is safe to re-run — it skips steps that are already complete (existing `config.yaml`, already-applied migrations, existing admin user). Use this to pick up a code update, rebuild the frontend, or re-install the systemd unit after editing `pktsnmp.service`.

### Installing in-place (repo checkout as install dir)

If the install directory you choose (or `PKTSNMP_INSTALL_DIR`) is the repo checkout itself, `install.sh` skips the file-copy step rather than failing — it runs directly against `app/`, `migrations/`, etc. in the checkout.

### Manual install (without install.sh)

If you'd rather not use the installer:

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip \
    libssl-dev libffi-dev libxmlsec1-dev libxmlsec1-openssl libxml2-dev pkg-config gcc

sudo mkdir -p /opt/pktsnmp/logs
sudo chown "$(whoami):$(whoami)" /opt/pktsnmp /opt/pktsnmp/logs

python3 -m venv /opt/pktsnmp/venv
/opt/pktsnmp/venv/bin/pip install -r requirements.txt

cp -r app migrations /opt/pktsnmp/
cp -r frontend/dist /opt/pktsnmp/frontend/dist   # after building the frontend

cp config.example.yaml /opt/pktsnmp/config.yaml
# Edit /opt/pktsnmp/config.yaml — set secret_key (openssl rand -hex 32), cors_origins.
# db_path, duckdb_path, log_file, and ssl_dir don't need to be set — they default to
# somewhere under install_dir. Pin install_dir explicitly so they resolve correctly:
echo 'install_dir: "/opt/pktsnmp"' >> /opt/pktsnmp/config.yaml

PKTSNMP_CONFIG=/opt/pktsnmp/config.yaml PKTSNMP_ADMIN_PASSWORD=changeme \
    /opt/pktsnmp/venv/bin/python3 -c \
    "import asyncio; from app.database import init_db, seed_admin; asyncio.run(init_db()); asyncio.run(seed_admin())"

sed -e "s#__INSTALL_DIR__#/opt/pktsnmp#g" -e "s#__LOG_DIR__#/opt/pktsnmp/logs#g" \
    -e "s#__SERVICE_USER__#$(whoami)#g" -e "s#__SERVICE_GROUP__#$(whoami)#g" \
    pktsnmp.service | sudo tee /etc/systemd/system/pktsnmp.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now pktsnmp
```

---

## Frontend Build & Deploy

The frontend is a standard Vite/React build — no special runtime requirements beyond Node.js 20+:

```bash
cd frontend
npm ci
npm run build
```

The built output lands in `frontend/dist/` and is served by FastAPI's `StaticFiles` mount. After a rebuild, copy it into the install directory and restart the service:

```bash
cp -r frontend/dist /opt/pktsnmp/frontend/dist
sudo systemctl restart pktsnmp
```

Or re-run `bash install.sh`, which copies `frontend/dist/` if present and restarts the service.

---

## Collector Setup

pktSNMP receives SNMP data two ways:

### Local collector (built-in)

Runs in-process on the pktSNMP host. Polls all devices assigned to `collector_id=1` via pysnmp, and listens for raw SNMP traps on UDP 162.

- Requires `AmbientCapabilities=CAP_NET_BIND_SERVICE` (already set in `pktsnmp.service`)
- Configure via **Settings → SNMP**: enable trap receiver, set poll interval
- Add devices via **Devices** and assign Collector = `local`

### Remote otelcol collectors

Existing OpenTelemetry Collector instances push OTLP HTTP JSON to pktSNMP.

Multiple otelcol instances can be registered, each with a unique bearer token — generated and rotated in **Settings → Collectors**. See `docs/collector-setup.md` for the full redirect/registration walkthrough.

**Minimal otelcol exporter block:**

```yaml
exporters:
  otlphttp/pktsnmp:
    endpoint: "http://SERVER-IP:8767/api/snmp/ingest/otlp"
    headers:
      Authorization: "Bearer YOUR_TOKEN_HERE"
    tls:
      insecure: true
```

> **Note:** otelcol automatically appends `/v1/metrics` to the endpoint. The actual POST hits `/api/snmp/ingest/otlp/v1/metrics`. Both paths are registered.

**Metric naming convention expected by the parser:**

```
SNMP/<SITE>/<DEVICE>/<OID_LABEL>
e.g. SNMP/SITE1/SW1/ifInOctets
```

Metrics not prefixed with `SNMP/` are ignored.

**Device resolution:** The ingest endpoint looks up each device by matching the collector ID and `otelcol_label` field (set on the device record in the UI). When matched, `devices.last_seen` and `devices.status='up'` are updated automatically on each ingest batch.

### Data flow

```
otelcol  →  POST /api/snmp/ingest/otlp/v1/metrics
         →  gzip decompress (otelcol compresses by default)
         →  parse_otlp_metrics()  →  resolve device by otelcol_label
         →  UPDATE devices SET last_seen, status='up'
         →  SQLite snmp_timeseries.db: snmp_poll_results

pysnmp local poller  →  asyncio GET loop
                     →  SQLite snmp_timeseries.db: snmp_poll_results

SNMP trap (UDP 162)  →  decode trap
                     →  SQLite snmp_timeseries.db: snmp_traps
```

---

## Configuration Reference

All startup/infrastructure settings live in `config.yaml`. Runtime settings (storage backend, SNMP credentials, retention, notifications) are managed in the UI and stored in SQLite.

`install_dir` is the app root — `db_path`, `duckdb_path`, `log_file`, and `ssl_dir` all default to somewhere under it and don't need to be set explicitly (the defaults below assume the default `/opt/pktsnmp` install dir). Override any individual one in `config.yaml` if it needs to live somewhere else.

| Key | Default | Description |
|---|---|---|
| `host` | `0.0.0.0` | Bind address |
| `port` | `8767` | HTTP port |
| `workers` | `2` | uvicorn workers |
| `secret_key` | — | JWT signing secret — **must change** |
| `install_dir` | detected at runtime | App root — pinned by `install.sh`; every path below defaults relative to this |
| `db_path` | `<install_dir>/pktsnmp.db` | SQLite control-plane DB |
| `duckdb_path` | `<install_dir>/snmp.duckdb` | DuckDB time-series file (if backend switched to DuckDB) |
| `clickhouse_host` | `localhost` | ClickHouse host (if switching storage) |
| `clickhouse_database` | `pktsnmp` | ClickHouse database name |
| `log_level` | `info` | `debug` / `info` / `warning` / `error` |
| `log_file` | `<install_dir>/logs/pktsnmp.log` | Log output path |
| `ssl_dir` | `<install_dir>/ssl` | Directory holding `server.crt` / `server.key` |
| `cors_origins` | `["http://SERVER-IP:8767"]` | Allowed CORS origins |

### SNMP settings (stored in SQLite, managed via UI)

| Setting key | Description |
|---|---|
| `snmp_trap_enabled` | Enable trap receiver |
| `snmp_trap_port` | Trap UDP port (default 162) |
| `snmp_poll_enabled` | Enable local poll engine |
| `snmp_poll_interval_seconds` | Default poll interval |
| `snmp_version` | `v1` / `v2c` / `v3` |
| `snmp_community` | Community string (v1/v2c) |
| `snmp_v3_auth_key` | SNMPv3 auth key (stored masked) |
| `snmp_v3_priv_key` | SNMPv3 privacy key (stored masked) |
| `storage_backend` | `"sqlite"` (default) / `"duckdb"` / `"clickhouse"` |

---

## Running & Managing the Service

```bash
# Status
sudo systemctl status pktsnmp

# Logs (live)
sudo journalctl -u pktsnmp -f
# or
tail -f /opt/pktsnmp/logs/pktsnmp.log

# Restart
sudo systemctl restart pktsnmp

# Stop / start
sudo systemctl stop pktsnmp
sudo systemctl start pktsnmp
```

---

## Upgrading

```bash
cd pktsnmp
git pull
cd frontend && npm ci && npm run build && cd ..
bash install.sh   # re-applies migrations, updates frontend/dist, restarts the service
```

Migrations run automatically on startup and are safe to re-run — the migration runner tracks applied files and skips duplicates.

---

## Roles & Auth

Three roles: `admin`, `analyst`, `viewer`.

| Action | Admin | Analyst | Viewer |
|---|---|---|---|
| View dashboard / alerts | ✓ | ✓ | ✓ |
| Acknowledge alerts | ✓ | ✓ | — |
| Manage devices / collectors | ✓ | ✓ | — |
| Configure alert rules | ✓ | — | — |
| Manage settings / users | ✓ | — | — |

### Local auth

The default admin user is created by `install.sh` (or `seed_admin()` in a manual install). Password is changed via Settings → Users or the key icon in the sidebar.

### Okta SAML 2.0

Configure in **Settings → Auth**:
1. Set the Okta Entity ID, SSO URL, and paste the IdP certificate
2. In Okta, create a SAML app with:
   - **Single sign-on URL (ACS):** `https://YOUR-FQDN:8767/api/auth/saml/callback`
   - **Audience URI (SP Entity ID):** `https://YOUR-FQDN:8767/api/auth/saml/metadata`
   - **Name ID format:** EmailAddress
3. Add a SAML attribute statement: Name = `role`, Value = `user.appuser.role` (or group-based EL expression)
4. Set each user's app-level role to `admin`, `analyst`, or `viewer` in Okta Assignments

> **Note:** The ACS URL must use the same hostname as the TLS certificate (`base_url` in Settings → General). HTTP is not supported for SAML.

---

## SNMP Settings

Configure via **Settings → SNMP** in the UI.

- **Trap receiver** — enable/disable, set UDP port (default 162). Restart service after changing port.
- **Poll engine** — enable/disable, set default poll interval. Per-device intervals can override the default.
- **SNMP version** — global default (v1 / v2c / v3). Override per device.
- **Community string** — used for v1/v2c devices without a per-device override.
- **SNMPv3 credentials** — auth key and priv key, stored masked at rest.

---

## SSL/TLS

SSL can be enabled or disabled via **Settings → General → SSL/TLS Toggle** without restarting the service.

| Setting key | Description |
|---|---|
| `ssl_enabled` | `true` / `false` — enables HTTPS |
| `ssl_certfile` | Absolute path to the TLS certificate file (PEM) |
| `ssl_keyfile` | Absolute path to the TLS private key file (PEM) |

When `ssl_enabled` is `true`, uvicorn binds with the provided cert/key and the service becomes HTTPS-only. When `false`, it binds plain HTTP. Change takes effect after a service restart (`sudo systemctl restart pktsnmp`).

> **SAML note:** The Okta SAML ACS URL must match the scheme (`https://`) set by your TLS configuration. If you toggle SSL, update the ACS URL in Okta accordingly.

---

## Alert Engine

The alert engine runs as a background task, evaluating all enabled rules every 60 seconds (with a 15-second startup delay).

### Built-in rule types

| Rule type | Severity | Description |
|---|---|---|
| `device_unreachable` | critical | Device `last_seen` stale / `status='down'` |
| `interface_down` | critical | Interface `ifOperStatus` transitions to down |
| `flapping` | warning | Interface up/down state change exceeds threshold in window |
| `metric_threshold` | configurable | OID value crosses a static threshold |
| `metric_spike` | warning | OID value increases by more than N% in one poll cycle |
| `error_rate` | warning | `ifInErrors` or `ifOutErrors` rate exceeds threshold |
| `discard_rate` | warning | `ifInDiscards` or `ifOutDiscards` rate exceeds threshold |
| `high_error_ratio` | warning | Error-to-traffic ratio exceeds configured percentage |
| `bandwidth_utilization` | configurable | Interface utilization exceeds threshold (% of `ifSpeed`) |
| `speed_change` | info | `ifSpeed` changes unexpectedly |
| `collector_gap` | warning | No ingest data received from a collector within window |
| `trap_received` | info | Any SNMP trap received from a device |

Custom rules are added via **Alerts → Rules** in the UI. Each rule specifies type, device scope, threshold values, severity, cooldown, and notification channels.

### Behavior

**Firing:** When `device_down` triggers (device `last_seen` is stale or `status='down'`):
- Inserts a row in `alert_events` with `device_id`, `severity`, `message`, `fired_at`
- Sets `devices.status = 'down'` so the dashboard dot immediately turns red
- Respects cooldown — won't re-fire if an open event already exists within the cooldown window (default 30 min)

**Resolving:** When the device starts reporting again:
- Sets `devices.status = 'up'`
- Sets `resolved_at = now()` on all open events for that rule + device

### UI indicators

- **Alerts menu badge** — shows the count of unresolved, unacknowledged events; polls every 30 seconds
- **Environment card** — red border and tinted header when any device is alerting
- **Device tree dots** — red pulsing dot on the device and its parent Org/Group/Site/Location nodes

Supported notification channels: `inapp`, `email`, `slack`, `pagerduty`, `webhook`.

---

## Device Hierarchy

Devices are organized in a five-level hierarchy: **Org → Group → Site → Location → Device**.

> **Note:** Prior to the Location level being added, this was a three-level Org → Group → Site
> hierarchy. Migrating installs shift existing data down automatically: what was in Group moves
> to Site, and what was in Site moves to the new Location level — Group starts out empty for
> every existing org (see the `(Unassigned)` placeholder in Settings → Hierarchy) and can be
> populated/reassigned as needed.

### Setup

1. Define Orgs, Groups, Sites, and Locations in **Settings → Hierarchy**
2. Assign each device to an Org, Group, Site, and Location when adding/editing it in **Devices**

### Dashboard tree

The Dashboard **Environment** card displays the full hierarchy. Status dots on Org, Group, Site, and Location nodes reflect the worst-case status of all devices beneath them:

- 🔴 Red (pulsing) — at least one device is `down`
- 🟡 Yellow (pulsing) — at least one device has active alerts
- 🟢 Green — all devices up and no alerts
- ⚫ Gray — no enabled devices or unknown

A device with a `parent_device_id` set only nests under its parent in the tree when they share
the same Org/Group/Site/Location — otherwise it's grouped under its own location, with a small
"Parent: `<name>`" badge pointing back to the parent.

### Device fields

| Field | Description |
|---|---|
| Name | Display name |
| IP | Management IP |
| Device type | `router` / `switch` / `firewall` / `server` / `wireless` / `ups` / `other` |
| Org / Group / Site / Location | Hierarchy assignment |
| Collector | Which collector polls this device |
| `otelcol_label` | Path prefix used to match OTLP metrics (e.g. `SITE1/SW1`) |
| HA role | `standalone` / `active` / `standby` |
| HA peer | Links to the paired HA device |
| Community / SNMP version | Per-device credential override |

### CSV import/export

Use **Export CSV** / **Import CSV** on the Devices page to bulk-manage devices. The import supports create (new name+IP) and update (existing record matched by name).

---

## Database Backends

Switch backends in **Settings → Storage**.

### SQLite (default)

- Zero-config, embedded, no separate service
- Control-plane DB: `/opt/pktsnmp/pktsnmp.db`
- Time-series DB: `/opt/pktsnmp/snmp_timeseries.db`
- Tables: `snmp_traps`, `snmp_poll_results`
- Suitable for most deployments

### DuckDB

- Embedded, no separate service — single-file analytical database
- Path configured via `duckdb_path` in `config.yaml`

### ClickHouse

- Requires a running ClickHouse server (not installed by `install.sh`)
- Database: `pktsnmp`, table: `snmp_data`
- Set credentials in `config.yaml`
- Better for very high-volume environments or long-term retention at scale

> **Note:** The storage backend is read from the `storage_backend` setting in SQLite at startup and cannot be changed while the service is running. Restart after switching.

---

## Backup & Restore

### Local project backup

A local backup script keeps dated .zip copies of the project source. The script is `backup.py` in the project root and keeps the last 2 rotations by default.

```bash
python backup.py
```

### Automated backup

Configure schedule and retention in **Settings → Backup**, or trigger immediately via the UI or:

```bash
curl -X POST http://SERVER-IP:8767/api/system/backup -H "Authorization: Bearer TOKEN"
```

Backups are stored in `/opt/pktsnmp/backups/`.

### Manual backup

```bash
cp /opt/pktsnmp/pktsnmp.db /opt/pktsnmp/backups/pktsnmp_$(date +%Y%m%d_%H%M%S).db
cp /opt/pktsnmp/snmp_timeseries.db /opt/pktsnmp/backups/snmp_timeseries_$(date +%Y%m%d_%H%M%S).db
```

### Restore

```bash
sudo systemctl stop pktsnmp
cp /opt/pktsnmp/backups/pktsnmp_<timestamp>.db /opt/pktsnmp/pktsnmp.db
cp /opt/pktsnmp/backups/snmp_timeseries_<timestamp>.db /opt/pktsnmp/snmp_timeseries.db
sudo systemctl start pktsnmp
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktsnmp -n 50`; check `config.yaml` paths and `secret_key` |
| Port 162 bind fails | Verify `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the service file; `sudo systemctl daemon-reload && sudo systemctl restart pktsnmp` |
| No data from otelcol | `journalctl -u otelcol` on collector host; check bearer token matches SQLite; verify `otelcol_label` on device record matches metric path prefix |
| 401 on `/ingest/otlp` | Token mismatch — rotate token in Collectors and update otelcol config |
| Collector status "unknown" | Collector hasn't pushed data yet; check otelcol is running and endpoint is reachable |
| `devices.last_seen` not updating | Verify `otelcol_label` on device matches SNMP metric path; check ingest endpoint returns 202 |
| Frontend blank / 404 | Build didn't complete; check `frontend/dist/` exists; rebuild and re-run `install.sh` |
| Alert fires but dot still green | Alert engine evaluates every 60s; wait one cycle. If persists, check `devices.status` in SQLite directly |
| Storage backend wrong on startup | `storage_backend` setting in SQLite takes effect on next restart; restart the service |
| ClickHouse not found | Verify ClickHouse is running: `systemctl status clickhouse-server`; check credentials in `config.yaml` |

---

## Development

### Backend (local)

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml   # edit paths as needed
uvicorn app.main:app --reload --port 8767
```

### Frontend (local)

```bash
cd frontend
npm install
npm run dev   # starts Vite dev server on :5174, proxied to :8767
```

Vite's proxy config in `vite.config.ts` forwards `/api/*` to the FastAPI backend.

### Project structure

```
pktsnmp/
├── app/
│   ├── api/          # FastAPI routers (alerts, auth, logs, settings, snmp, system, users)
│   ├── auth/         # Local JWT + Okta SAML handlers
│   ├── alerts/       # Alert engine (real, 60s loop) + cleanup
│   ├── snmp/         # Trap receiver, poll engine, OTLP parser, OID catalog
│   ├── storage/      # SQLite time-series, DuckDB, ClickHouse backends, factory
│   ├── models/       # Pydantic models
│   ├── backup.py
│   ├── config.py
│   ├── database.py   # Migration runner (idempotent, skips duplicate column errors)
│   ├── dependencies.py
│   ├── logging_handler.py
│   └── main.py
├── frontend/
│   └── src/
│       ├── pages/    # Dashboard, Alerts, Settings, Login, Collectors, Devices, Logs, OidCatalog
│       ├── components/  # Layout (nav + alert badge), AiAssistant
│       ├── store/    # auth, autoRefresh
│       └── api/      # typed API client (client.ts)
├── migrations/       # SQLite schema migrations (auto-applied at startup, append-only)
├── config.example.yaml
├── requirements.txt
├── install.sh        # Ubuntu bare-metal installer
├── pktsnmp.service   # systemd unit template (placeholders filled in by install.sh)
└── backup.py
```

Deployment/diagnostic scripts specific to a given environment belong in a local, untracked `scripts/` directory (already covered by `.gitignore`) — they are not part of this repository.

### Migrations

Migration files live in `migrations/` and are named `NNN_description.sql`. They are applied in filename order at startup. The runner tracks applied migrations in a `_migrations` table and skips already-applied files. It also silently ignores `duplicate column name` errors so migrations are safe to re-run after partial failures.

To add a new migration: create `migrations/NNN_your_change.sql` and restart the service.

---

## pktHub Integration

pktSNMP integrates with pktHub (the suite management hub) via a suite token. Once registered, pktHub proxies access to pktSNMP and manages authentication for all managed pktAPP apps.

### Suite token endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/suite/token` | Returns the current suite token (generates one if absent) |
| `POST` | `/api/suite/regenerate` | Generates a new token, invalidates the old one |
| `POST` | `/api/suite/register` | Called by pktHub to record registration state |

### Registration steps

1. In pktSNMP, go to **Settings → Integrations → pktHub Integration** and click **Copy Token**
2. In pktHub, go to **Settings → App Registry → Register App**
3. Paste the suite token, enter the pktSNMP base URL, and click **Register**
4. pktHub validates via `/api/health` and stores the token
5. Optionally flip to **Managed Mode** once proxied access is validated

### Managed mode

In managed mode, every request to pktSNMP must carry the `X-Suite-Token` header. Direct browser access to port 8767 returns `403`. To revert without pktHub access, run the emergency unlock CLI:

```bash
python app/main.py --emergency-unlock
```

This removes the suite-token requirement, restores direct access, and logs the event locally.

### Token rotation

Use **Regen** in pktSNMP Settings → Integrations to generate a new token. After regenerating, re-register in pktHub (the old token is immediately invalidated).

---

## Related projects

| Project | Port | Description |
|---|---|---|
| pktHub | 8760 | Unified NOC/SOC management hub — registers, proxies, and manages all pktAPP apps |
| pktFlow | — | NetFlow ingest and visualization (pktSNMP ancestor) |
| pktLog | — | Syslog ingest and management |
| pktPCAP | — | Packet capture and analysis |

Logos for all pkt apps are served from the pktHub `/logos/` endpoint.
