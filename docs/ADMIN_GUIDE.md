# pktSNMP — Administrator Guide

Covers installing, configuring, and operating pktSNMP. For day-to-day usage (dashboard, alerts, metrics), see [USER_GUIDE.md](USER_GUIDE.md). See the [README](../README.md) for the full technical/API reference.

## Installation

```bash
git clone git@github.com:bsnwgit/pktsnmp.git
cd pktsnmp
bash install.sh
```

`install.sh` prompts for an install directory (default `/opt/pktsnmp`) and port (default `8767`), then handles OS packages, the Python venv, `config.yaml` (with a generated `secret_key`), database migrations, the admin user (prints the generated password once — save it), the frontend build, and a systemd service (installed and started). Open the app port in your firewall, and `162/udp` too if you'll use the built-in SNMP trap receiver.

Log in with the printed admin credentials and change the password immediately (sidebar → key icon, or Settings → Security → Users).

## First-time setup checklist

1. **Change the admin password.**
2. **Set up the device hierarchy** (Settings → Hierarchy): Org → Group → Site → Location. Devices attach to a Location.
3. **Add devices** (Devices page) and/or **register remote collectors** (Settings → Collectors) if devices are polled by remote otelcol collectors rather than this server directly.
4. **Add SNMP credentials** (Settings → SNMP → Credential Library) so devices don't need inline v2c/v3 secrets.
5. **Review the OID Catalog** (Settings → OID Catalog) — bundled OID/label mappings, extend with your own via CSV import if needed.
6. **Configure alert rules** and notification channels (Notifications tab) so the team actually hears about problems.
7. **Set up backups** (Data → Backups) and confirm a manual backup succeeds.
8. **Create accounts** for your team with appropriate roles (admin / analyst / viewer).

## Users & roles

Three roles — `admin`, `analyst`, `viewer` — see the table in [USER_GUIDE.md](USER_GUIDE.md#logging-in). Manage accounts at Settings → Security → Users: create, change role, reset password, deactivate. The built-in admin from install is a normal user record and can be renamed/rotated like any other, just don't delete every admin account at once.

### Okta SAML SSO

Settings → Security → Auth:
1. Set the Okta Entity ID, SSO URL, and paste the IdP certificate (a metadata-XML paste box will parse these three fields for you instead of typing them by hand).
2. The ACS URL pktSNMP expects is shown on the same tab — configure it in Okta's app integration.
3. Role sync from IdP group/attribute claims can be configured here too.
4. If local auth AND SAML are both disabled, the login page is skipped entirely and the app auto-logs in as the default admin — only appropriate for a trusted, access-controlled network.

## Settings reference

Settings is split into two sections, picked from a section bar above the tab
bar: **Common** (shared by every pkt* app) and **pktSNMP** (this app's own).
The tab bar shows one section's tabs at a time. Deep links like
`/settings?tab=hierarchy` still land on the right tab — the section follows
automatically.

### Common section

| Tab | Sub-tab | What it controls |
|---|---|---|
| General | — | App name, `base_url`, timezone, Restart Service button |
| Security | Users | Accounts, roles, password resets |
| | Auth | Okta SAML configuration |
| | Suite Integration | Suite token, pktHub registration status |
| | SSL / TLS | HTTPS toggle, cert/key upload |
| Data | Storage | Time-series backend (SQLite/DuckDB/ClickHouse), storage stats |
| | Backups | Schedule, retention, manual backup, restore |
| Notifications | — | Slack / Email / PagerDuty / Webhook / TraceCat channels |
| Resonance | — | Embedded assistant — server address, key, who may open it, placement (admin only) |
| User Keys | — | Per-user external lookup API keys (ipinfo.io, ipapi.is, AbuseIPDB, MXToolbox, IPQualityScore) |
| System | — | Version/build info, host and runtime details, open-source notices |

### pktSNMP section

| Tab | Sub-tab | What it controls |
|---|---|---|
| SNMP | — | Trap receiver, poll engine, SNMP Credential Library |
| Collectors | — | Remote otelcol collector registration + tokens, CSV import/export |
| OID Catalog | — | OID/label mappings, CSV import/export |
| Hierarchy | — | Org/Group/Site/Location tree management |

**Restart required:** SNMP trap/poll engine enable-disable, port/interval/concurrency changes, and SSL toggle all require a service restart (`sudo systemctl restart pktsnmp`, or the Restart Service button on General) — they don't live-reload. Adding/editing devices or SNMP credentials does *not* need a restart; the poll engine picks those up on its next cycle.

## SNMP configuration

- **Trap receiver**: UDP, default port 162. Enable/disable and change the port on Settings → SNMP.
- **Poll engine**: default poll interval and max concurrent polls, overridable per device.
- **SNMP version**: global default (v1/v2c/v3), overridable per device or per named credential.
- **Credential Library**: maintain reusable named credentials (community string for v2c; security name/level/auth+priv protocols and keys for v3) instead of storing secrets per-device.

## Device hierarchy

Devices live under a five-level tree: **Org → Group → Site → Location → Device**. Manage the tree at Settings → Hierarchy (admin-only) — create/rename/delete Orgs, Groups, Sites, and Locations. If this install predates the Location level, existing data was migrated automatically (old Group → new Site, old Site → new Location) and a `(Unassigned)` Group placeholder was created per Org; reassign as needed.

## Alert engine

Runs as a background task, evaluating enabled rules every 60 seconds (15-second startup delay). Built-in rule types, grouped as they appear in the New Rule picker:

| Group | Rule types |
|---|---|
| Device | Device down, Poll failure spike, Auth failure, Device poll gap |
| Interface | Interface down, Interface flapping |
| Metric | Metric threshold, Metric spike, Error rate, Discard rate, High error ratio, Bandwidth utilization, Interface speed change |
| Trap | Unknown trap source, Trap rate spike, Trap OID match, Specific trap received |
| Collector | Collector data gap |
| Threshold | OID value threshold, OID missing |

Configure rules and severities under the Alerts area; wire up delivery channels under Notifications — enabling a channel there doesn't send anything on its own, it just makes it available for a rule to use. Each channel has a **Send Test** button that performs a real dispatch using whatever's currently filled in, even if unsaved.

## Database backends

Switch under Settings → Data → Storage:

- **SQLite (default)** — zero-config, embedded. Control-plane DB at `<install_dir>/pktsnmp.db`, time-series DB at `<install_dir>/snmp_timeseries.db`. Fine for most deployments.
- **DuckDB** — embedded, single-file, path set via `duckdb_path` in `config.yaml`.
- **ClickHouse** — not yet functional; requires a self-managed ClickHouse server (not installed by `install.sh`), intended for very high-volume/long-retention environments.

Use **Test Connection** on the Storage tab to verify the currently configured backend is reachable before relying on it.

## Backup & Restore

Configure schedule, rotation, and path at Settings → Data → Backups (or trigger immediately with **Run Backup Now**, or `POST /api/system/backup`). Each run creates a timestamped snapshot directory under the configured backup path containing `pktsnmp.db`, `config.yaml`, and — if "Include ClickHouse data" is on — `snmp_data.csv.gz`.

**Restoring:**
- Every listed snapshot has a **Restore…** link — restores directly from that on-server snapshot, no download/upload needed. Expanding it shows a checkbox per file actually present in that snapshot, so you can restore just one piece (e.g. only `config.yaml`) instead of always restoring everything.
- **Export bundle** downloads a one-off `.tar.gz` of the same three files; **Restore from bundle** uploads one back, with the same per-file selection available.
- Any restore that includes `config.yaml` requires a service restart afterward to actually apply. Restoring the JWT secret in `config.yaml` invalidates existing browser sessions — everyone will need to log in again.
- The time-series database (`snmp_timeseries.db`, SQLite backend) is **not** included in any backup path above — it can grow very large and isn't covered by `app/backup.py`. Back it up separately at the filesystem level if you need that history preserved (`cp` while the service is stopped, or your own snapshot tooling).

## SSL/TLS

Settings → Security → SSL/TLS: toggle HTTPS, upload a PEM cert+key or a PFX/PKCS12 bundle with passphrase. The toggle saves immediately but — like the rest of this tab — needs a service restart to take effect. If you use SAML, keep the Okta ACS URL's scheme (`http`/`https`) in sync with this setting.

## Suite Integration (pktHub)

### Managed mode

pktHub can put this app into **Managed mode**, which stops people reaching its UI directly and sends them to the hub instead. Nothing needs configuring here: the hub sends the address to redirect to when it applies the lock, because that address is built from the hub's own Base URL and this app's id in the hub's registry, and neither is visible from this side.

The lock redirects rather than shuts down. Anything carrying a valid suite token passes through untouched, as do `/api/health`, `/api/suite/`, `/api/auth/` and the paths a hub-rendered page needs, so pktHub itself keeps working normally.

**It expires on its own.** Every call from pktHub refreshes a heartbeat and the lock releases after five minutes without one, so it does not depend on the hub coming back — a lock only pktHub could lift would strand this app exactly when pktHub is what broke. `GET /api/suite/mode` reports the current state without authentication.

For an install with no pktHub in front of it, the address can be set directly with `PATCH /api/suite/hub-redirect-url` (admin session; http/https only, since every visitor follows it while the lock is on). pktHub overwrites it whenever it applies a lock.

pktSNMP can be registered with pktHub for centralized auth/proxying:
1. Settings → Security → Suite Integration → **Copy Token**.
2. In pktHub: Settings → App Registry → Register App, paste the token and this app's base URL.
3. Once registered, pktHub can proxy pktSNMP's Settings page (shows a "remotely managed" banner here) and its dashboards/widgets.

Regenerate the token any time from the same tab if it's compromised — the old one stops working immediately and pktHub's registration will need the new token.

## Cleanup / retention

Settings → Data → Storage has a manual cleanup trigger (or it runs automatically) for old alert events and time-series data past your configured retention window — check that tab for the current retention settings before assuming old data is permanent.

## Resonance (embedded assistant)

Settings → Resonance (admin only). Adds an assistant launcher to the bottom corner of every page. The assistant itself runs on the resonance server; pktSNMP only decides who may open it.

**Setting it up.** Paste the **interface server** address — not resonance's admin portal, which answers on a different address and serves `embed.js` too, so it looks right until the session call returns "not found" — then the key you were issued. Choose which roles may use it, press **Test Connection**, and only then switch **Enabled** on. Test Connection works whether or not the feature is enabled; always prove a key before putting the widget in front of users. Every field ships blank, so a fresh install shows nothing until it is pointed at a resonance server of its own.

Two things have to line up on the resonance side, and both fail silently when they don't:

- **This install's origin** must be on the key's allow-list. The exact string is shown ready to copy on the same page. Behind a reverse proxy, fill in **pktSNMP's own address** yourself — what the app detects is the internal address, not the one users type.
- **Speakers Name** must be on for the key. Without it resonance records nothing, so there is no trace of who asked what.

**Reachability, twice over.**

- Resonance must be reachable **from the browser**, over HTTPS, with a certificate those browsers already trust. An untrusted certificate produces an empty widget and nothing in the console to explain it.
- pktSNMP also calls resonance **server to server**, so this host must resolve resonance's name and trust its certificate — the browser doing both is not enough. Python verifies against its own bundled roots rather than the system store, so a certificate signed by an internal CA is trusted by every browser on the network and still rejected here. Point **CA bundle** at the system store instead (`/etc/ssl/certs/ca-certificates.crt` on Debian and Ubuntu).

**What it can reach.** The devices pktSNMP polls and one device in full, the interfaces discovered on a device, the collectors doing the polling, the estate summary, alert rules and the alerts they have fired, and pktSNMP's own diagnostic log. Every call is made by pktSNMP's own page on the session of whoever is signed in, so it reaches only what that person could already open in the interface. Which operations exist is fixed in the code, not configurable per install — `/.well-known/resonance.json` lists exactly what is on offer, and needs no login to read because it contains names, not data.

**What it can never reach**, at any role level: an SNMP credential of any kind — community string, v3 auth or privacy key, collector SSH key or API token. Those columns are not selected, so they cannot arrive through a schema's `extra` either. Nothing the assistant can call creates, edits or deletes a device, collector, credential or OID, and nothing polls a device on demand.

Documentation is published separately at `GET /api/resonance/docs`, to a suite token or an admin session — the guides shipped with the running version, so pointing resonance at it keeps the assistant's knowledge in step with the installed release instead of describing last year's UI.

**What each role can do.** Set per role. *No access* hides the launcher entirely. *Read only* lets the assistant look at the operations above. *Read and write* also lets it act — and adds exactly three things, no more: acknowledge one alert, acknowledge all of them, and switch an existing alert rule on or off. There is no delete of anything and no creating or editing of configuration. Resonance stops and reads the actual values back to the person before it runs any of them.

**A level never exceeds the role.** Two checks have to agree: the level set here, and pktSNMP's own rule for the thing being done. Setting a level grants nobody a right they did not already have — it decides whether the assistant may use the rights they do.

Where no role is set to *Read and write*, the write operations are withheld from the published grant altogether, so there is nothing at the resonance end that could be turned on. Every write the assistant performs is recorded in the application log with who asked for it.

**Credentials.** pktSNMP never sends a login to resonance. It vouches for whoever is signed in and gets back a short-lived, single-use code the browser spends on opening the panel. The key is encrypted at rest and never reaches the browser.

**If it never appears.** Diagnostics reports how many users could not load the widget in the last week; the usual causes are an ad blocker, a wrong server address, or resonance being unreachable. Repeated failures pause the integration for a few minutes rather than hammering resonance — the panel says so while it is paused, and a successful Test Connection clears it.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u pktsnmp -n 50`; check `config.yaml` paths and `secret_key` |
| Port 162 (trap) bind fails | Verify `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the systemd unit; `sudo systemctl daemon-reload && sudo systemctl restart pktsnmp` |
| Login page flickers an error then clears | Known historical bug (fixed) — if you see it again, confirm you're on a current build |
| A restored `config.yaml` didn't take effect | You need to restart the service — restoring never does this automatically |
| Settings changes don't seem to apply | Check whether that specific setting requires a restart (see the "Restart required" note above) |

## Upgrading

Pull the latest code, re-run the frontend build if you build manually (`cd frontend && npm install && npm run build`), then restart the service. Database migrations run automatically on startup and are safe to re-run.
