<p align="center">
  <img src="lockup-256h.png" alt="pktSNMP" height="80" />
</p>

# pktSNMP

SNMP ingest management and visualization platform — part of the pkt suite. Receives SNMP traps and poll data from network devices, stores them in DuckDB or ClickHouse, and surfaces them through a React UI with alerting and an AI assistant.

**Default port:** `8767`

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Fresh Install](#fresh-install)
- [Frontend Build & Deploy](#frontend-build--deploy)
- [Collector Setup](#collector-setup)
- [Configuration Reference](#configuration-reference)
- [Running & Managing the Service](#running--managing-the-service)
- [Upgrading](#upgrading)
- [Roles & Auth](#roles--auth)
- [SNMP Settings](#snmp-settings)
- [Alert Rules](#alert-rules)
- [Database Backends](#database-backends)
- [Backup & Restore](#backup--restore)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Logos & Branding](#logos--branding)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     pktSNMP server                       │
│                                                          │
│   pktsnmp.service  (uvicorn / FastAPI)  :8767            │
│   ├── REST API  (app/api/)                               │
│   ├── SNMP trap receiver  (UDP 162, asyncio)             │
│   ├── Local poll engine   (pysnmp, asyncio)              │
│   ├── Alert engine        (background task)              │
│   └── AI assistant        (Anthropic)                    │
│                                                          │
│   SQLite  pktsnmp.db    ← settings, users, devices,     │
│                            alert rules, notification log │
│   DuckDB  snmp.duckdb   ← snmp_traps, snmp_poll_results │
│   (or ClickHouse, switchable in Settings → Storage)      │
│                                                          │
│   React SPA  /opt/pktsnmp/frontend/dist/                 │
│   served by uvicorn StaticFiles                          │
└──────────────────────────────────────────────────────────┘
         ▲                        ▲
         │ OTLP HTTP              │ SNMP trap (UDP 162)
         │                        │
┌────────────────┐      ┌─────────────────────┐
│ otelcol        │      │ Network devices      │
│ (remote        │      │ (routers, switches,  │
│  collectors)   │      │  firewalls)          │
└────────────────┘      └─────────────────────┘
```

### Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + aiosqlite (Python 3.11+) |
| Time-series store | DuckDB (default) or ClickHouse |
| App database | SQLite (`pktsnmp.db`) |
| Frontend | React 18 + TypeScript + Tailwind CSS + Vite |
| Auth | JWT (15 min) + httpOnly refresh (7 days) + Okta SAML 2.0 |
| SNMP | pysnmp-lextudio (v1/v2c/v3 traps and polling) |
| Service | systemd `pktsnmp.service` |

---

## Prerequisites

**On the server:**
- Python 3.11+
- Node.js 20+ via NVM (for frontend builds)
- Git
- Optional: ClickHouse (if switching storage backend)

**On your workstation (Windows):**
- Python 3.x + Paramiko (`pip install paramiko`)
- SSH key for the server in a known path
- **Do not install Node on Windows** — the `node_modules` tree is OS-specific; builds must run on the server

---

## Fresh Install

### 1 — Clone the repo on the server

```bash
ssh -i your-key.pem user@<server-ip>
cd /opt
git clone git@github.com:<org>/pktsnmp.git pktsnmp
cd pktsnmp
```

### 2 — Python virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 3 — Configuration

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` at minimum:

```yaml
# Generate a strong secret key:
#   openssl rand -hex 32
secret_key: "PASTE_OUTPUT_HERE"

db_path: "/opt/pktsnmp/pktsnmp.db"
duckdb_path: "/opt/pktsnmp/snmp.duckdb"
log_file: "/var/log/pktsnmp.log"
```

### 4 — Database migrations

Migrations run automatically at startup. To apply manually:

```bash
source venv/bin/activate
python -c "from app.database import run_migrations; import asyncio; asyncio.run(run_migrations())"
```

### 5 — Systemd service

```bash
sudo cp pktsnmp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pktsnmp
sudo systemctl start pktsnmp
sudo systemctl status pktsnmp
```

### 6 — Build & deploy the frontend

See [Frontend Build & Deploy](#frontend-build--deploy) below.

### 7 — First login

Navigate to `http://<server-ip>:8767` and log in with the default admin credentials set during installation. **Change the password immediately** in Settings → Users.

---

## Frontend Build & Deploy

The frontend **must be built on the Linux server** — the `node_modules` directory contains Linux-native binaries that won't cross-compile from Windows.

### Automated (recommended)

From your Windows workstation:

```bash
# Edit the key path and server IP in the script first
python scripts/deploy_frontend.py
```

The script will:
1. SSH to the server via Paramiko
2. Pull latest changes from git
3. Run `npm ci` (if `package.json` changed)
4. Run `npm run build`
5. Restart `pktsnmp.service`

### Manual (on the server)

```bash
cd /opt/pktsnmp/frontend
source ~/.nvm/nvm.sh
nvm use 20
npm ci
npm run build
sudo systemctl restart pktsnmp
```

The built output lands in `frontend/dist/` and is served by FastAPI's `StaticFiles` mount.

---

## Collector Setup

pktSNMP receives SNMP data two ways:

### Local collector (built-in)

Runs in-process on the server. Polls all devices assigned to `collector_id=1` via pysnmp, and listens for raw SNMP traps on UDP 162.

- Requires `AmbientCapabilities=CAP_NET_BIND_SERVICE` (already set in `pktsnmp.service`)
- Configure via **Settings → SNMP**: enable trap receiver, set poll interval
- Add devices via **Devices** and assign Collector = `local`
- **Does not affect remote otelcol collectors** — remote collectors operate independently

### Remote otelcol collectors

Existing OpenTelemetry Collector instances that push SNMP data to pktSNMP via OTLP HTTP. Add and manage them in **Settings → Collectors**.

**Minimal otelcol exporter block:**

```yaml
exporters:
  otlphttp/pktsnmp:
    endpoint: "http://<server-ip>:8767"
    headers:
      Authorization: "Bearer YOUR_COLLECTOR_TOKEN"
    tls:
      insecure: true
```

Add `otlphttp/pktsnmp` to your SNMP pipeline's exporters list.

**Syncing collector config from the UI:**

1. Go to **Collectors** → select a remote collector
2. Configure SSH credentials (key or password) under the SSH tab
3. Click **Sync** — pktSNMP will SSH to the collector, patch its otelcol YAML with the correct SNMP receiver blocks (community strings, device IPs, OIDs), and restart otelcol

### SNMP credentials

Credentials are managed in **Settings → Credentials**. Naming convention: `<version>-<collector-name>[-<security-level>]` — e.g. `v2c-site-a`, `v3-datacenter-authPriv`.

- Community strings are masked by default in the UI (`••••••••`)
- Admins can reveal community strings via a per-row view/hide toggle
- Credentials are stored encrypted at rest (Fernet)

### Data flow

```
otelcol  →  POST /api/snmp/ingest/otlp  →  parse_otlp_metrics()
                                         →  resolve device by otelcol_label
                                         →  DuckDB: snmp_poll_results

pysnmp local poller  →  asyncio GET loop  →  DuckDB: snmp_poll_results

SNMP trap (UDP 162)  →  decode trap       →  DuckDB: snmp_traps
```

---

## Configuration Reference

All startup/infrastructure settings live in `config.yaml`. Runtime settings (storage backend, SNMP credentials, retention, notifications) are managed in the UI and stored in SQLite.

| Key | Default | Description |
|---|---|---|
| `host` | `0.0.0.0` | Bind address |
| `port` | `8767` | HTTP port |
| `workers` | `2` | uvicorn workers |
| `secret_key` | — | JWT signing secret — **must change** |
| `db_path` | `/opt/pktsnmp/pktsnmp.db` | SQLite path |
| `duckdb_path` | `/opt/pktsnmp/snmp.duckdb` | DuckDB path |
| `clickhouse_host` | `localhost` | ClickHouse host (if used) |
| `clickhouse_database` | `pktsnmp` | ClickHouse database name |
| `log_level` | `info` | `debug` / `info` / `warning` / `error` |
| `log_file` | `/var/log/pktsnmp.log` | Log output path |
| `cors_origins` | `["http://localhost:8767"]` | Allowed CORS origins |

### SNMP settings (stored in SQLite, managed via UI)

| Setting key | Description |
|---|---|
| `snmp_trap_enabled` | Enable trap receiver |
| `snmp_trap_port` | Trap UDP port (default 162) |
| `snmp_poll_enabled` | Enable local poll engine (does not affect remote collectors) |
| `snmp_poll_interval_seconds` | Default poll interval |
| `snmp_version` | `v1` / `v2c` / `v3` |
| `snmp_community` | Community string (v1/v2c) |
| `snmp_v3_auth_key` | SNMPv3 auth key (stored masked) |
| `snmp_v3_priv_key` | SNMPv3 privacy key (stored masked) |

---

## Running & Managing the Service

```bash
# Status
sudo systemctl status pktsnmp

# Logs (live)
sudo journalctl -u pktsnmp -f
# or
tail -f /var/log/pktsnmp.log

# Restart
sudo systemctl restart pktsnmp

# Stop / start
sudo systemctl stop pktsnmp
sudo systemctl start pktsnmp
```

---

## Upgrading

From your workstation:

```bash
python scripts/deploy_frontend.py
```

Or manually on the server:

```bash
cd /opt/pktsnmp
git pull
source venv/bin/activate
pip install -r requirements.txt   # if requirements changed
cd frontend
source ~/.nvm/nvm.sh && nvm use 20
npm ci
npm run build
sudo systemctl restart pktsnmp
```

Migrations run automatically on startup. No manual schema steps needed unless noted in the migration file comments.

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

Default admin is created by the install script. Password is changed on first login via Settings → Users.

### Okta SAML 2.0

Configure in **Settings → Auth**:
1. Set the Okta Entity ID, SSO URL, and paste the IdP certificate
2. In Okta, create a SAML app pointing to `http://<server-ip>:8767/auth/saml/acs`
3. Map the `role` attribute from Okta claims to `admin` / `analyst` / `viewer`

---

## SNMP Settings

Configure via **Settings → SNMP** in the UI.

- **Trap receiver** — enable/disable, set UDP port (default 162). Restart service after changing port.
- **Local polling engine** — enable/disable the built-in poller on this server. Remote otelcol collectors are unaffected — they are managed under **Collectors**.
- **SNMP version** — global default (v1 / v2c / v3). Override per device.
- **Community string** — used for v1/v2c devices without a per-device override.
- **SNMPv3 credentials** — auth key and priv key, stored encrypted at rest.

---

## Alert Rules

Built-in rules (active by default):

| Rule | Type | Severity | Description |
|---|---|---|---|
| Device unreachable | `device_down` | critical | No SNMP response for configured silence window |
| Unknown trap source | `unknown_trap_source` | warning | Trap received from unregistered device |

Custom rules are added in **Settings → Alert Rules**. Supported channels: `inapp`, `email`, `slack`, `pagerduty`, `webhook`.

---

## Database Backends

Switch backends in **Settings → Storage**.

### DuckDB (default)

- Zero-config, embedded, no separate service
- Data file: `snmp.duckdb`
- Tables: `snmp_traps`, `snmp_poll_results`
- Suitable for most deployments up to tens of millions of rows

### ClickHouse

- Requires a running ClickHouse server
- Database: `pktsnmp`, table: `snmp_data`
- Set credentials in `config.yaml`
- Better for very high-volume environments or long-term retention at scale

---

## Backup & Restore

### Automated backup

Trigger from the UI via **Settings → Backup**, or run:

```bash
python backup.py
```

Backs up `pktsnmp.db` (SQLite) and `snmp.duckdb` to the backup directory configured in Settings.

### Manual backup (on the server)

```bash
cp /opt/pktsnmp/pktsnmp.db /opt/pktsnmp_backups/pktsnmp_$(date +%Y%m%d_%H%M%S).db
cp /opt/pktsnmp/snmp.duckdb /opt/pktsnmp_backups/snmp_$(date +%Y%m%d_%H%M%S).duckdb
```

### Restore

```bash
sudo systemctl stop pktsnmp
cp /opt/pktsnmp_backups/pktsnmp_<timestamp>.db /opt/pktsnmp/pktsnmp.db
cp /opt/pktsnmp_backups/snmp_<timestamp>.duckdb /opt/pktsnmp/snmp.duckdb
sudo systemctl start pktsnmp
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktsnmp -n 50`; check `config.yaml` paths and `secret_key` |
| Port 162 bind fails | Verify `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the service file; `systemctl daemon-reload && systemctl restart pktsnmp` |
| No data from otelcol | `journalctl -u otelcol` on collector host; check bearer token matches SQLite; verify `otelcol_label` on device record |
| 401 on `/ingest/otlp` | Token mismatch — rotate token in Settings → Collectors and update the collector config |
| Collector sync fails | Check SSH credentials in Settings → Collectors → SSH tab; verify the key has access to the collector host |
| Collector status "unknown" | Collector hasn't pushed data yet; check otelcol is running and the OTLP exporter endpoint is correct |
| Frontend blank / 404 | Build didn't complete; check `frontend/dist/` exists; rebuild via `deploy_frontend.py` |
| Database locked | Stop service before manually copying DuckDB files; DuckDB is single-writer |
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
│   ├── alerts/       # Alert engine + cleanup
│   ├── snmp/         # Trap receiver, poll engine, collector push, OID catalog
│   ├── storage/      # DuckDB + ClickHouse backends, factory
│   ├── models/       # Pydantic models
│   ├── backup.py
│   ├── config.py
│   ├── database.py
│   ├── dependencies.py
│   ├── logging_handler.py
│   └── main.py
├── frontend/
│   └── src/
│       ├── pages/    # Dashboard, Alerts, Settings, Login, Collectors, Devices, Logs, OidCatalog
│       ├── components/  # Layout, AiAssistant
│       ├── store/    # auth, autoRefresh (Zustand)
│       └── api/      # typed API client
├── migrations/       # SQLite schema migrations (auto-applied at startup)
├── scripts/          # Deployment + collector update scripts (Paramiko-based)
├── config.example.yaml
├── requirements.txt
├── pktsnmp.service
└── backup.py
```

### Deployment notes

- **Never build the frontend on Windows** — `node_modules` contains Linux-native rollup binaries
- **Use Paramiko for SSH** — avoids system SSH client restrictions in some environments
- **One script run, no retry loops** — repeated SSH connections can lock the server
- Migrations are append-only; add new files (`005_*.sql`, etc.) and they auto-apply on next startup

---

## Related projects

| Project | Description |
|---|---|
| pktFlow | NetFlow ingest and visualization (pktSNMP ancestor) |
| pktDashboard | Suite home / logo hosting |

---

## Logos & Branding

| File | Description |
|---|---|
| `lockup.svg` | Full SVG lockup (wordmark + icon) — preferred for docs |
| `lockup-256h.png` | PNG lockup, 256 px tall |
| `lockup-128h.png` | PNG lockup, 128 px tall |
| `lockup-64h.png` | PNG lockup, 64 px tall |
| `icon.svg` | Icon-only SVG |
| `icon-512.png` … `icon-16.png` | Icon PNGs at 512 / 256 / 128 / 64 / 48 / 32 / 16 px |
| `favicon.ico` | Browser favicon |
