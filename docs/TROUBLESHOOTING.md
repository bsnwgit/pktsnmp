# pktSNMP — Troubleshooting

Symptom, cause, and the command that proves which cause it is.

`<INSTALL_DIR>` is the install directory (`/opt/pktsnmp` by default),
`<DEVICE_IP>` a polled device, `<COLLECTOR_HOST>` a remote otelcol collector.

---

## Contents

- [The first five minutes](#the-first-five-minutes)
- [The service will not start](#the-service-will-not-start)
- [The service runs but nothing answers](#the-service-runs-but-nothing-answers)
- [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404)
- [Login and accounts](#login-and-accounts)
- [No traps are arriving](#no-traps-are-arriving)
- [Polling returns nothing](#polling-returns-nothing)
- [A collector shows offline](#a-collector-shows-offline)
- [Remote collector sync fails](#remote-collector-sync-fails)
- [Storage backends — read this before switching](#storage-backends--read-this-before-switching)
- [Alerts and notifications](#alerts-and-notifications)
- [A config change did not take effect](#a-config-change-did-not-take-effect)
- [TLS / HTTPS](#tls--https)
- [Backup and restore](#backup-and-restore)
- [Upgrades and migrations](#upgrades-and-migrations)
- [Performance and disk](#performance-and-disk)
- [Uninstalling and reinstalling](#uninstalling-and-reinstalling)
- [What to capture before reporting a problem](#what-to-capture-before-reporting-a-problem)

---

## The first five minutes

```bash
sudo systemctl status pktsnmp --no-pager
```

```bash
sudo journalctl -u pktsnmp -n 100 --no-pager
```

```bash
sudo tail -n 100 <INSTALL_DIR>/logs/pktsnmp.log
```

```bash
sudo ss -ltnp | grep 8767; sudo ss -lunp | grep 162
```

```bash
curl -s http://127.0.0.1:8767/api/health
```

| What you see | Go to |
|---|---|
| `inactive (dead)` or `failed` | [The service will not start](#the-service-will-not-start) |
| Running, nothing on 8767 | [The service runs but nothing answers](#the-service-runs-but-nothing-answers) |
| Health 200, UI blank or 404 | [The UI is blank, stale, or 404](#the-ui-is-blank-stale-or-404) |
| Running, nothing on UDP 162 | [No traps are arriving](#no-traps-are-arriving) |
| No metrics from any device | [Polling returns nothing](#polling-returns-nothing) |

**Both the trap receiver and the poll engine are off by default**
(`snmp_trap_enabled` and `snmp_poll_enabled` are `False`). A fresh install that
"does nothing" is usually a fresh install with nothing enabled.

Grep the log for the two lines that tell you what actually started:

```bash
grep "Local collector started" <INSTALL_DIR>/logs/pktsnmp.log | tail -1
grep "Trap receiver failed to start" <INSTALL_DIR>/logs/pktsnmp.log | tail -5
```

---

## The service will not start

```bash
sudo journalctl -u pktsnmp -n 200 --no-pager
sudo tail -n 200 <INSTALL_DIR>/logs/pktsnmp.log
```

Reproduce in the foreground:

```bash
sudo -u <service-user> \
  PKTSNMP_CONFIG=<INSTALL_DIR>/config.yaml \
  PKTSNMP_INSTALL_DIR=<INSTALL_DIR> \
  <INSTALL_DIR>/venv/bin/python -m app.server
```

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | venv missing packages, or built against a different Python | `<INSTALL_DIR>/venv/bin/pip install -r requirements.txt`; rebuild the venv if Python was upgraded |
| `yaml.scanner.ScannerError` | `config.yaml` is not valid YAML | `python3 -c "import yaml; yaml.safe_load(open('<INSTALL_DIR>/config.yaml'))"` |
| Complaint about `secret_key` / `credential_key` | Left at `CHANGE_ME_…` | `openssl rand -hex 32`; and `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `Address already in use` on 8767 | Something else holds the port | `sudo ss -ltnp \| grep 8767` |
| Fernet `InvalidToken` | `credential_key` changed after SNMP credentials were stored | See [A config change did not take effect](#a-config-change-did-not-take-effect). SNMPv3 keys and SSH credentials are encrypted with it |
| `Permission denied` on DB or logs | Install dir not owned by the service user | `sudo chown -R <service-user>:<service-group> <INSTALL_DIR>` |

The unit is ordered `After=network.target clickhouse-server.service` with
`Wants=clickhouse-server.service`. That is only ordering — pktSNMP starts
whether or not ClickHouse does, because ClickHouse is not the default backend.

### The app starts but traps silently do not

A trap receiver that fails to bind is **caught and logged, and the app carries
on**:

```
Trap receiver failed to start: <error>
```

The service stays `active (running)` with traps off and nothing in the UI
saying so. Always check for that line before concluding the network is at
fault.

---

## The service runs but nothing answers

```bash
sudo ss -ltnp | grep 8767
```

`host:` and `port:` are read from `config.yaml` at every process start, so a
port change needs only a restart, never a unit edit.

- Bound to `127.0.0.1` → reachable only from the host. Set `host: "0.0.0.0"`.

```bash
curl -sv http://127.0.0.1:8767/api/health
```

If loopback works and nothing else does, it is the firewall, the bind address,
or routing — not the app.

---

## The UI is blank, stale, or 404

| Symptom | Cause | Fix |
|---|---|---|
| `{"detail":"Not Found"}` at the root | The frontend was never built | `cd frontend && npm install && npm run build`, then restart. Node.js 20.x LTS is a prerequisite `install.sh` does not install |
| Blank page, console 404s on `/assets/*` | `dist` stale or half-built | Rebuild, then hard-refresh |
| Old UI after an upgrade | Cached `index.html` pinning old hashed bundles | Hard refresh (Ctrl/Cmd-Shift-R) |
| Every API call 401 | Session expired — see [Login and accounts](#login-and-accounts) |
| Login page flickers an error then clears | A historical bug, fixed | Confirm you are on a current build before investigating further |

---

## Login and accounts

bcrypt plus JWT. Roles `admin` / `analyst` / `viewer`. Sessions time out after
`session_timeout_minutes` (default 480). Okta SAML is supported and off by
default.

| Symptom | Cause | Fix |
|---|---|---|
| 401 immediately after logging in | Clock skew invalidates the token's `exp` | `timedatectl`; fix NTP |
| SAML login loops | IdP metadata mismatch | `okta_saml_idp_entity_id`, `okta_saml_idp_sso_url`, `okta_saml_idp_cert` (cert **without** header/footer). `okta_saml_sp_entity_id` defaults to `base_url/api/auth/saml/metadata` |
| SAML works, local login does not | `auth_local_enabled` is off | Re-enable it, or use SAML |
| Locked out of every account | No admin session left | Reset the hash against SQLite, using the app's own venv for bcrypt |

```bash
<INSTALL_DIR>/venv/bin/python -c "import bcrypt; print(bcrypt.hashpw(b'NewPassword1!', bcrypt.gensalt()).decode())"
```

---

## No traps are arriving

### Step 1 — is the receiver even on?

`snmp_trap_enabled` is a **setting**, default `False`, and so are
`snmp_trap_port` (162) and `snmp_trap_bind_address` (`0.0.0.0`). None of them
are in `config.yaml`.

```bash
sudo ss -lunp | grep 162
grep "Local collector started" <INSTALL_DIR>/logs/pktsnmp.log | tail -1
```

That log line reports `trap=` and `poll=` as they were actually resolved at
startup. These are read **once, at process start** — enabling them in Settings
does nothing until you restart.

### Step 2 — did the bind fail?

Port 162 is privileged. The unit sets `AmbientCapabilities=CAP_NET_BIND_SERVICE`
for exactly this reason.

```bash
grep "Trap receiver failed to start" <INSTALL_DIR>/logs/pktsnmp.log | tail -5
systemctl cat pktsnmp | grep -i capabilit
```

If the capability is missing after a manual unit edit:

```bash
sudo systemctl daemon-reload && sudo systemctl restart pktsnmp
```

Remember the failure is non-fatal — the app runs on regardless.

### Step 3 — is anything on the wire?

```bash
sudo tcpdump -ni any udp port 162 -c 20
```

No packets is a device or network problem. Check the device's trap destination
address and port, community string, and anything filtering UDP in between.

### Step 4 — traps arrive but nothing appears

| Cause | Check |
|---|---|
| The sending device is not registered | Traps from an unknown device have nowhere to attach |
| Wrong SNMP version or community | v1 and v2c traps carry the community; a mismatch is silently dropped by the parser |
| SNMPv3 trap without matching credentials | v3 requires the engine to be able to authenticate it |
| The varbinds are unrecognised OIDs | The trap is stored but renders thinly — check the OID catalog |

---

## Polling returns nothing

`snmp_poll_enabled` is a setting, default `False`, read at process start.

| Symptom | Cause | Fix |
|---|---|---|
| Nothing polls at all | Poll engine disabled | Enable it, then **restart** |
| One device fails, others work | Credentials or reachability for that device | Test from the app host: `snmpwalk -v2c -c <community> <DEVICE_IP> sysDescr.0` |
| Every device fails | Wrong global defaults | `snmp_version` (`v1`/`v2c`/`v3`), `snmp_community`, or the v3 set: `snmp_v3_username`, `snmp_v3_auth_protocol` (MD5/SHA), `snmp_v3_auth_key`, `snmp_v3_priv_protocol` (DES/AES), `snmp_v3_priv_key` |
| v3 fails with an auth error | Protocol mismatch, not just a wrong key | The device must agree on both auth and priv protocols |
| Device reachable by ping, not by SNMP | An ACL on the device restricting which source IPs may poll it | Add this server |
| A specific OID returns nothing | The device does not implement it | Confirm against the OID catalog and the device's own MIB support |
| Metrics stop after a credential change | Credentials are encrypted with `credential_key` | If that key changed, stored credentials are unrecoverable — re-enter them |

Device up/down alerting reads `devices.status` and `devices.last_seen`, which
the poll engine keeps current. A device that never polled successfully has never
had those set.

---

## A collector shows offline

The `collectors` table's `last_seen` and `status` — and the `effective_status`
the UI shows — are normally only updated by the bearer-token-authenticated OTLP
ingest and heartbeat endpoints that **remote otelcol collectors** call over
HTTP.

The **local** collector (id 1, seeded by `migrations/002_phase2.sql`) never calls
those endpoints, so it runs its own heartbeat loop instead — but only when trap
or poll is actually enabled.

| Symptom | Cause |
|---|---|
| Local collector shows offline, but polling/traps clearly work | On an older build this was exactly the missing heartbeat. Confirm you are current |
| Local collector shows offline and nothing is working | Neither trap nor poll is enabled, so no heartbeat runs. That is consistent, not a bug |
| A remote collector shows offline | It is not reaching the OTLP ingest/heartbeat endpoints — check network path, and that its bearer token matches |
| Remote collector was working, now offline | Token rotated here without updating the collector, or its otelcol service stopped |

---

## Remote collector sync fails

`POST /collectors/{id}/sync` pushes otelcol config over SSH: connect with
Paramiko (key or password), SFTP-read the existing YAML, patch the `snmp/*`
receivers and pipeline receiver lists, SFTP-write it back, then
`sudo systemctl restart <otelcol_service>`.

Every one of those steps can fail independently, and `sync_status` records which.

| Symptom | Cause | Fix |
|---|---|---|
| Authentication failed | Wrong SSH key or password | Credentials are stored encrypted; re-enter if `credential_key` changed |
| Host key rejected | Host key policy | The collector's host key changed or was never accepted |
| SFTP read fails | The otelcol config path is wrong, or unreadable by that SSH user | Confirm the path on the collector host |
| Patch fails | The existing YAML is not what the patcher expects | Look at the config on the collector; `app/snmp/otelcol_config.py` defines the shape it patches |
| SFTP write fails | Permissions on the config file or directory | The SSH user must be able to write it |
| Restart fails | The SSH user has no passwordless sudo for `systemctl restart <otelcol_service>` | Grant it, or restart the collector by hand |
| Sync reports success, still no data | The config was written and the service restarted, but the receivers are not reaching the devices | Check the collector host's own otelcol logs |

---

## Storage backends — read this before switching

**`sqlite` is the default and the only complete backend.**

> sqlite is the only backend that implements the full StorageBase interface;
> duckdb and clickhouse are both missing several query methods.
> — [`app/api/settings.py`](../app/api/settings.py)

This is the reverse of pktFlow and pktLog, where ClickHouse is the full backend.
Switching pktSNMP to ClickHouse or DuckDB **removes functionality** — pages and
queries backed by the missing methods will fail.

| Symptom | Cause |
|---|---|
| Pages that worked now error, after switching backend | A query method the new backend does not implement |
| Data "disappeared" after switching | The backends are separate stores; switching does not migrate. Switch back to see it |
| ClickHouse connection errors | Only relevant if you switched to it — `clickhouse_host`/`_port`/`_user`/`_password` in `config.yaml` |
| Disk filling | `retention_days_raw` (90), `retention_days_hourly` (365) |

---

## Alerts and notifications

Channels are in-app, Email (SMTP), Slack, PagerDuty, generic Webhook and
Tracecat. Senders are written never to raise, so **a failing channel looks like
nothing happening**. Use Send Test to get the real error.

| Symptom | Cause |
|---|---|
| No alerts at all | Nothing is being collected — fix traps or polling first |
| Device-down alerts never fire | They read `devices.status`/`last_seen`, which only the poll engine maintains. With polling disabled they cannot fire |
| Email never arrives | SMTP host, port (default 587), TLS, credentials, or the relay refusing the sender |
| Slack 4xx | Webhook revoked or malformed |
| Webhook target sees nothing | Method, headers, or the Jinja2 payload template failing to render |

---

## A config change did not take effect

**Most pktSNMP settings are read once, at process start.** Trap enable, trap
port, bind address and poll enable all take effect only on restart — saving the
form changes the stored value, not the running process.

Beyond that, the usual four:

**Wrong file.** Env vars beat `config.yaml` silently:

```bash
systemctl show pktsnmp -p Environment
```

**Not restarted.** Nothing in `config.yaml` is re-read live, and restoring a
backed-up `config.yaml` never restarts the service.

**The setting is not in `config.yaml`.** That file holds startup and
infrastructure only. Storage backend, retention, every SNMP setting, alert rules,
notification channels and SAML live in **SQLite** and are managed in the UI.

**`credential_key` changed or was lost.** SNMPv3 keys and SSH credentials are
Fernet-encrypted with it. Change it and they become undecryptable — restore the
old key or re-enter everything. This is why `uninstall.sh` keeps `config.yaml`
by default.

---

## TLS / HTTPS

`ssl_dir` defaults to `<INSTALL_DIR>/ssl`.

| Symptom | Cause | Fix |
|---|---|---|
| Still HTTP after uploading a cert | Not restarted | Restart |
| Will not start after upload | Key does not match the cert, or is unreadable by the service user | Compare `openssl x509 -noout -modulus -in cert.pem \| openssl md5` with `openssl rsa -noout -modulus -in key.pem \| openssl md5` |
| Certificate warning | Self-signed, or the SAN does not cover the hostname used | Expected for self-signed |
| A sibling app's health check fails on TLS | Suite calls verify the target's certificate | Fix the target's cert, or clear verify-TLS for that connection |

```bash
curl -k https://127.0.0.1:8767/api/health
```

---

## Backup and restore

| Symptom | Cause |
|---|---|
| No backups appearing | Schedule off, or settings unset — they live in SQLite, not `config.yaml` |
| Backups fail | Backup root not writable, or disk full |
| Restore "worked" but nothing changed | A restored `config.yaml` never restarts the service |
| Restored elsewhere and credentials fail | `credential_key` differs — restore `config.yaml` too |

**Never copy a live SQLite database with `cp`.** Take `pktsnmp.db`, `-wal` and
`-shm` with the service stopped, or use `sqlite3 … ".backup"`. On the default
sqlite backend that database holds the metrics as well as the settings, so it is
the whole product.

---

## Upgrades and migrations

Numbered `.sql` files, run on startup, tracked in `_migrations`, safe to re-run.

```bash
git pull
cd frontend && npm install && npm run build && cd ..
sudo systemctl restart pktsnmp
```

Re-running `install.sh` is better when a release drops or renames a file. Data is
kept, and the port you enter is applied to the existing `config.yaml` without
touching another line. `PKTSNMP_REMOVE_EXISTING=1` (or `0`) answers that prompt
from a script.

| Symptom | Cause |
|---|---|
| `no such column` / `no such table` | Migrations did not run — the app failed earlier in startup |
| A migration fails | Compare `SELECT * FROM _migrations` against `ls migrations/`. Restore from backup first |
| Local collector row missing | It is seeded by `migrations/002_phase2.sql` as id 1 |
| App upgraded, UI did not | Frontend not rebuilt, or browser cache |
| `VERSION` looks wrong | Bumped by `scripts/bump_version.py`, never by hand |

---

## Performance and disk

```bash
df -h
du -sh <INSTALL_DIR>/*
```

| Symptom | Where to look |
|---|---|
| Disk filling | `pktsnmp.db` itself on the sqlite backend, plus `logs/`, `backups/`, `snmp.duckdb` |
| Polling falling behind | Number of devices against the poll interval; SNMP timeouts on unreachable devices are slow |
| Traps dropped under load | UDP has no back-pressure — a trap storm is lost, not queued |
| Queries slow | Retention, then the backend. On sqlite the DB grows without bound if retention is not applied |

---

## Uninstalling and reinstalling

```bash
bash <INSTALL_DIR>/uninstall.sh
```

Stops and removes the service, deletes the code and the venv. **Data is kept by
default** — `config.yaml`, `pktsnmp.db` and its `-wal`/`-shm`, `logs/`,
`backups/`, `ssl/` and `snmp.duckdb`. It asks separately, defaulting to no.

| Flag | Effect |
|---|---|
| *(none)* | Remove service, code and venv; keep data |
| `--purge` | Also delete config, database, logs, backups and TLS material. Not recoverable |
| `--dry-run` | Print what would be removed |
| `--yes` | Skip prompts |
| `--dir PATH` | Install directory, if the unit is already gone |

`--purge` does not drop a ClickHouse database — it may be shared with the rest
of the suite.

**Never mirror over an install directory with `rsync --delete`.** On the default
backend that would destroy the metric history along with the settings.

---

## What to capture before reporting a problem

1. `VERSION`, and how it was installed.
2. `systemctl status pktsnmp` plus the last 200 lines of **both** the journal and
   `logs/pktsnmp.log`.
3. The `Local collector started -- trap=… poll=…` line from the log.
4. Any `Trap receiver failed to start` lines.
5. `config.yaml` **with `secret_key`, `credential_key` and passwords removed**.
6. Which storage backend is selected.
7. For traps: `sudo ss -lunp | grep 162` and `tcpdump` output proving packets
   arrive.
8. For polling: `snmpwalk` from this host to the device, showing whether SNMP
   works at all outside the app.

Never paste real secrets, community strings, SNMPv3 keys, or an unredacted
`config.yaml`.
