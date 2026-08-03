# pktSNMP — TODO

Status key: ⬜ not started · 🔄 in progress · ✅ complete

Last reconciled against `git log` and the current codebase 2026-07-27. Phases 1–6 below
(the original build-out plan) are now **complete** — see the changelog at the bottom for
what actually shipped, since a lot of the original phase descriptions undersold or
predated what's really there now (hierarchy went to 5 levels, alert rule types grew to
12, per-interface metrics, a credential library, etc.). See `README.md` for full current
feature documentation.

---

## Phase 1 — App Shell (complete)

✅ FastAPI backend scaffold (main.py, auth, users, settings, system, backup, alerts)
✅ SNMP settings keys (trap port, poll interval, version, community) + named SNMP Credential Library (v2c/v3, masked at rest, referenced by devices via `credential_id`)
✅ Storage layer (SQLite default, DuckDB fully implemented, ClickHouse factory wiring present but **not implemented** — see Known Gaps)
✅ SQLite migrations (users, settings, devices, alert_rules, alert_events, notification_log, hierarchy tables, credentials, HA fields — 20 migrations as of this writing)
✅ JWT + httpOnly refresh token auth
✅ Okta SAML 2.0 SSO
✅ Notification channels: `inapp`, `email`, `slack`, `pagerduty`, `webhook` (TraceCat, listed in an earlier draft of this file, was never shipped — remove it from any future planning)
✅ Backup scheduler + export/import bundle
✅ systemd service definition (pktsnmp.service)
✅ React + TypeScript + Tailwind + Vite frontend
✅ Settings page — General / Security (Users, Auth, Suite Integration, AI Assistant, SSL-TLS) / Data (Storage, Backups) / Notifications / User Keys / SNMP (incl. Credential Library) / Collectors / OID Catalog / Hierarchy — see README's "Settings Layout" section for the full current tab map (Collectors and OID Catalog moved from top-level nav into Settings tabs)
✅ Dashboard — environment hierarchy tree with live status rollup, recent traps/alerts widgets
✅ Alerts — 12 built-in rule types, custom rules, CSV import/export, Investigate deep-links
✅ AI Assistant panel — multi-provider (Settings → Security → AI Assistant): local/self-hosted (Ollama, or any OpenAI-compatible endpoint) tried first, then cloud (Anthropic); each provider independently enabled/disabled
✅ install.sh (Ubuntu bare-metal installer — interactive install-dir + port prompts)
✅ backup.py (local 2-rotation zip)
✅ App-wide contextual help (`?` popovers on nearly every page/tab)
✅ Per-user IP intelligence / reputation lookup for public IPs (ipinfo.io, ipapi.is, AbuseIPDB, MXToolbox — per-user keys under Settings → User Keys), plus a separate internal-IP lookup for private/RFC1918 addresses sourced from a registered pktIPAM instance (Settings → Security → Suite Integration → Sibling pkt Apps)

## Phase 2 — SNMP Engine (complete)

✅ **Trap receiver** — UDP listener on configured port (default 162), pysnmp-lextudio, v1/v2c/v3
✅ **Device registry** — full CRUD, 5-level hierarchy assignment (Org/Group/Site/Location/Device), HA role/peer, CSV import/export
✅ **Polling engine** — asyncio poll loop; scalar OIDs via GET, ifTable-indexed OIDs via per-interface GETBULK walk; closes its SNMP engine after each device to avoid fd leaks; polls every catalog OID each cycle (no truncation); device/credential changes live-reload the running poller without a restart
✅ **OID catalog** — bundled common OIDs + custom OID/label mappings, CSV import/export, template download
✅ **Topology collection** — ARP (`ipNetToMediaTable`), IPv4 routes (`ipCidrRouteTable`), and per-port VLAN walked alongside the regular metrics poll; full-replace per cycle into `arp_entries`/`routes`/`interfaces` tables; exposed read-only via `/api/snmp/devices/{id}/arp-entries` and `/routes` for sibling apps (currently pktIPAM) — no dedicated UI page in pktSNMP itself, see Phase 6

## Phase 3 — Storage Implementation

✅ **SQLite** (default) — `ingest_trap`, `ingest_poll_result`, `query_traps`, `query_poll_history`, `run_cleanup`, per-interface queries — all implemented in `app/storage/sqlite_ts.py`
✅ **DuckDB** — same method set implemented in `app/storage/duckdb.py`
⬜ **ClickHouse** — `app/storage/clickhouse.py` only implements `connect`/`close`/`health_check`; `ingest_trap`, `ingest_poll_result`, `query_traps`, `query_poll_history` all raise `NotImplementedError`. **Do not select ClickHouse as the storage backend** until this is finished — see README's Database Backends section.
✅ Retention: SNMP raw data (`snmp_traps`/`snmp_poll_results`) purges via `run_cleanup(retention_days_raw)`, triggerable via `/api/snmp/cleanup` or `/api/system/cleanup`; alert_events/notification_log purge automatically once/day via `AlertCleanup`
⬜ Automatic (scheduled) purge of SNMP raw data — currently admin-triggered only, unlike the alert-event cleanup which already runs on its own daily loop

## Phase 4 — Alert Engine (complete)

✅ Real alert rules engine, 12 built-in rule types (`device_unreachable`, `interface_down`, `flapping`, `metric_threshold`, `metric_spike`, `error_rate`, `discard_rate`, `high_error_ratio`, `bandwidth_utilization`, `speed_change`, `collector_gap`, `trap_received`) — all deletable, none permanently protected by id
✅ Fire → `alert_events` row, device status sync, cooldown, resolve-on-recovery
✅ Alerts UI — Active/History, ack/ack-all, severity + time-range filtering (incl. custom range), CSV import/export/template, Investigate deep-links to Metrics/Collectors/Dashboard
✅ Layout header badge — unresolved/unacknowledged count, polls every 30s

## Phase 5 — Dashboard (complete)

✅ Environment hierarchy tree (Org→Group→Site→Location→Device) with worst-case status rollup and pulsing alert/down indicators
✅ Recent-traps widget
✅ Per-device Metrics pages: Traffic/Packets/Errors&Discards/IP-Protocol by interface, plus a separate System Resources (CPU/Memory/Storage) page
✅ Active alert count wired to real alert events
✅ Disabled-device banners on Dashboard and Metrics (a disabled device's tile is visibly marked and non-interactive rather than silently showing stale data)

## Phase 6 — Polish (mostly complete)

⬜ Dark/light theme toggle — app is dark-theme only, no toggle exists
✅ CSV export of trap/poll and alert-rule data
✅ Per-device OID/metrics dashboard pages
⬜ Topology view — the underlying ARP/route/interface data is now collected and API-accessible (see Phase 2), but there's still no in-app UI page to browse it directly within pktSNMP; today it's only surfaced through the pktIPAM integration and the private-IP lookup modal

---

## Known Gaps (as of 2026-07-27)

- **ClickHouse storage backend is unimplemented.** Selectable in Settings → Data → Storage but will raise on first ingest/query. Treat SQLite/DuckDB as the only real options.
- **IPQualityScore** has a key-storage slot (Settings → User Keys) but isn't wired into the IP intelligence lookup modal yet — only ipinfo.io + AbuseIPDB are actually queried.
- **SNMP raw-data retention cleanup is manual-trigger only** (no daily scheduled job like the alert-event cleanup has).
- **Docker distribution was built and then explicitly removed** (see PR #18 then #19) in favor of the Ubuntu bare-metal installer — don't resurrect a Dockerfile without confirming that decision has changed.

## Changelog highlights (chronological, see `git log` for full detail)

- Org→Group→Site hierarchy, device types, CSV import/export, real alert engine
- SQLite made the default storage backend (was DuckDB)
- SSL/TLS enable/disable toggle without restart; SAML SSO + admin-only settings fixes; 64-bit traffic counters
- Docker support added, then removed in favor of a sanitized Ubuntu install path
- Fresh-install bug sweep: `seed_admin` column bug, suite-token JSON crash, collector heartbeat endpoint, device-delete FK handling, `pysnmp` → `pysnmp-lextudio` rename, SNMP v2c/v3 mismatch — all fixed
- Location added as a 4th hierarchy level (migrating installs auto-shift existing Group/Site data down); storage-backend default bug fixed; dashboard parent-device display fixed; dead alert-engine calls removed
- Hierarchy inline-rename UI; disabled-device banners on Dashboard/Metrics
- Local poll engine rewritten to collect real per-interface metrics (was previously not doing this at all) — root-caused a chain of 6 bugs; Metrics/Dashboard UX fixes
- SNMP poll engine file-descriptor leak fixed (unclosed `SnmpEngine` per device); `oids[:20]` cap removed (was silently dropping every OID past the 20th, including all `hr*`/vendor OIDs)
- Alert engine storage-routing + timezone-display fixes; time-range filtering (incl. custom range) added; bulk CSV import/export for collectors and alert rules
- Application Logs server-side pagination; alert Investigate deep-links
- App-wide contextual help; per-user IP intelligence/reputation lookup
- Suite Integration settings label renamed (was "pktHub Integration"); Copy-Token fixed on HTTP; Enter-to-submit added to login
- Poll-interval setting reconnected to the poll engine (`snmp_poll_default_interval_seconds`/`snmp_poll_max_concurrency` now both UI-controlled and read by the poller); device/credential changes now live-reload the poller without a restart
- ipapi.is and MXToolbox added as IP-intelligence providers alongside ipinfo.io/AbuseIPDB; separate private/internal-IP lookup added, sourced from a registered pktIPAM instance (subnet, DHCP lease, DNS records, ARP last-seen)
- Alerts Active/History and Application Logs gained an independent page-size selector (25/50/75/100, default 25)
- ARP table, IPv4 routing table, and per-port VLAN collection added to the local poll engine, exposed read-only for sibling apps over the Suite Integration channel
- Collectors and OID Catalog moved from top-level nav pages into Settings tabs (alongside SNMP and Hierarchy); Collectors/OID Catalog management is now admin-only like the rest of Settings
