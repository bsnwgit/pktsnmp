# pktSNMP — Claude Working Notes

## Project overview

pktSNMP is an SNMP ingest management and UI platform. It mirrors pktFlow (a NetFlow platform) in look, feel, and shared infrastructure. Port **8767**, app path `/mnt/software/pktsnmp`, server O2 at `172.23.80.5`.

The shared sections (General, Storage, Backup, Auth, Notifications, Integrations, Users) are feature-complete and match pktFlow. SNMP-specific work (trap receiver, polling engine, alert rules, dashboard charts) is tracked in `TODO.md`.

## SECURITY-CRITICAL RULES — read before every session

- **RULE 1 — NEVER MARK TODO ITEMS COMPLETE WITHOUT EXPLICIT USER INSTRUCTION.**
- **RULE 2 — NEVER WRITE CODE OR MAKE FILE CHANGES WITHOUT EXPLICIT USER APPROVAL.**
- **RULE 3 — NEVER DEPLOY WITHOUT BEING TOLD TO.**
- **RULE 4 — BACKUP BEFORE MARKING COMPLETE.**

## SSH / deployment constraints

- SentinelOne EDR blocks `system ssh.exe` on this Windows machine. **Always use Python + Paramiko** (see `scripts/deploy_frontend.py`).
- **Never build the frontend on Windows** — `node_modules` there is Windows-only and lacks the Linux rollup native binary. All `npm run build` commands run on O2 via Paramiko.
- ONE script, ONE run, NO retry loops — hammering the SSH connection locks the server and requires a reboot.

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + aiosqlite (SQLite sidecar) |
| Data storage | DuckDB (default) or ClickHouse (switchable in settings) |
| Frontend | React 18 + TypeScript + Tailwind CSS + Vite |
| Auth | JWT (15 min access) + httpOnly refresh (7 days) + Okta SAML 2.0 |
| Service | systemd `pktsnmp.service` on O2 |

## Key paths

```
/mnt/software/pktsnmp/          # app root on O2
/mnt/software/pktsnmp_backups/  # server-side backup snapshots
/mnt/software/logs/pktsnmp.log  # service log
```

## Settings notes

- Settings stored as JSON key/value in SQLite `settings` table.
- Secret keys (anthropic_api_key, okta_saml_idp_cert, snmp_v3_auth_key, snmp_v3_priv_key, etc.) are masked as "••••••••" in GET responses.
- SNMP keys added: `snmp_trap_enabled`, `snmp_trap_port`, `snmp_poll_enabled`, `snmp_poll_interval_seconds`, `snmp_version`, `snmp_community`, `snmp_v3_*`.

## Ports

- Backend: **8767** (configurable in settings → base_url)
- Frontend dev (Vite): **5174**, proxied to 8767

## Roles

`admin` · `analyst` · `viewer`

## pktFlow relationship

pktSNMP was forked from pktFlow. Files adapted:
- Removed: ingest buffer, NetFlow UDP listener, flows/topology/talkers routes, DevicesTab, IngestTab, `retention_days_raw` TTL side effect, `ingest_token` secret key, NetFlow-specific sampler device table columns.
- Added: SNMP settings keys, stub SNMP router, SNMP-specific alert rules in initial migration, SNMP tab in Settings.
- Unchanged (verbatim or near-verbatim): auth.py, users.py, AiAssistant, store/auth, store/autoRefresh, most helper components in Settings.tsx.

## Frontend files (src/pages)

| File | Status | Notes |
|---|---|---|
| `Settings.tsx` | Complete | 8 tabs: General, SNMP, Storage, Backup, Auth, Notifications, Integrations, Users |
| `Dashboard.tsx` | Stub | Stat cards wired to `/api/snmp/status`; charts TODO |
| `Alerts.tsx` | Stub | Table structure ready; `/api/alerts/events` returns [] until Phase 4 |
| `Login.tsx` | Complete | pktSNMP branding |

## Common gotchas

- `api.runCleanup()` returns `snmp_data_eligible` (not `flows_eligible`/`hourly_eligible`).
- ClickHouse table name is `snmp_data` (not `flows`) — see TODO in `app/storage/clickhouse.py`.
- DuckDB tables: `snmp_traps`, `snmp_poll_results` (schema in `app/storage/duckdb.py`).
- SQLite DB file: `pktsnmp.db` (not `pktflow.db`).
- Config path: `/mnt/software/pktsnmp/config.yaml`.
