# pktSNMP — TODO

Status key: ⬜ not started · 🔄 in progress · ✅ complete

---

## Phase 1 — App Shell (complete)

✅ FastAPI backend scaffold (main.py, auth, users, settings, system, backup, alerts stub)  
✅ SNMP settings keys (trap port, poll interval, version, community, v3 credentials)  
✅ Storage layer (DuckDB default, ClickHouse stub, factory)  
✅ SQLite migrations (users, settings, devices, alert_rules, alert_events, notification_log)  
✅ JWT + httpOnly refresh token auth  
✅ Okta SAML 2.0 SSO  
✅ Notification channels (Slack, Email, PagerDuty, Webhook, TraceCat)  
✅ Backup scheduler + export/import bundle  
✅ systemd service definition (pktsnmp.service)  
✅ React + TypeScript + Tailwind + Vite frontend  
✅ Settings page (General, SNMP, Storage, Backup, Auth, Notifications, Integrations, Users)  
✅ Dashboard stub  
✅ Alerts stub  
✅ AI Assistant panel (Claude, gated on anthropic_api_key)  
✅ deploy_frontend.py (Paramiko SSH, O2 build)  
✅ backup.py (Windows 2-rotation zip)  

---

## Phase 2 — SNMP Engine

⬜ **Trap receiver** — UDP listener on configured port (default 162)  
- Add pysnmp or easysnmp dependency  
- Parse SNMP v1/v2c/v3 traps  
- Write to `snmp_traps` table in DuckDB/ClickHouse  
- Emit to alert engine  

⬜ **Device registry** — CRUD for polled devices  
- `GET/POST/PUT/DELETE /api/snmp/devices`  
- Fields: ip, hostname, snmp_version, community, v3_creds, enabled, poll_interval_override  
- UI: SNMP Devices tab under Settings  

⬜ **Polling engine** — active OID polling  
- Scheduled poll loop (APScheduler or asyncio)  
- Per-device OID list configuration  
- Write results to `snmp_poll_results` table  
- Track device up/down state  

⬜ **OID catalog** — human-readable OID names  
- Bundle common OIDs (ifInOctets, sysDescr, hrProcessorLoad, etc.)  
- Allow custom OID → label mappings per device  

---

## Phase 3 — Storage Implementation

⬜ **DuckDB** — implement `ingest_trap`, `ingest_poll_result`, `query_traps`, `query_poll_history`  
⬜ **ClickHouse** — implement same methods for `snmp_traps` and `snmp_poll_results` tables  
⬜ Retention TTL enforcement for snmp_data (hook into settings `retention_days_raw`)  

---

## Phase 4 — Alert Engine

⬜ **Alert rules engine** — evaluate rules against incoming traps/poll results  
- Rule types: device_down, unknown_trap_source, threshold_breach, specific_trap_oid  
- Fire → write `alert_events`, trigger notification channels  
- API: `GET/POST/PUT/DELETE /api/alerts/rules`  

⬜ **Alerts UI** — wire `GET /api/alerts/events` (currently stub returns [])  
- Ack / Ack All  
- Filter by severity, rule, device  
- Show fired count in Layout header badge  

---

## Phase 5 — Dashboard

⬜ **Trap timeline chart** — 24h bar chart of trap volume  
⬜ **Device status grid** — up/down/unknown per device with last-seen  
⬜ **OID sparklines** — per-device poll history for key OIDs  
⬜ **Top trap sources** — table of devices by trap count  
⬜ **Active alert count** — wire to real alert events  

---

## Phase 6 — Polish

⬜ Dark/light theme toggle  
⬜ CSV export of trap and poll history  
⬜ Per-device OID dashboard pages  
⬜ Topology view (optional — low priority)  
