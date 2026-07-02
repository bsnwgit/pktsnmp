#!/usr/bin/env python3
"""
Clear all old data and deploy the two bug fixes:
  1. Migration 015 — adds device_id column to alert_events (fixes Alerts page crash)
  2. snmp.py — ingest now updates devices.last_seen (fixes stale device status)

Clears:
  - Service log (truncated so only fresh output visible)
  - alert_events table
  - snmp_poll_results table (stale/empty anyway, fresh start)
  - snmp_traps table
"""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import os, sys, time, paramiko
sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH   = r"PATH\TO\YOUR-KEY.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("SERVER-IP", username="ssh-user", pkey=key, timeout=15)
print("Connected.")
sftp = c.open_sftp()

def run(cmd, timeout=30):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("STDERR:", err)
    return out

# ── 1. Upload migration 015 ─────────────────────────────────────────────────
print("\n── Uploading migration 015 ──")
sftp.put(
    os.path.join(LOCAL_ROOT, "migrations", "015_alert_device_id.sql"),
    f"{REMOTE_APP}/migrations/015_alert_device_id.sql",
)
print("Uploaded 015_alert_device_id.sql")

# ── 2. Upload fixed snmp.py ─────────────────────────────────────────────────
print("\n── Uploading snmp.py ──")
sftp.put(
    os.path.join(LOCAL_ROOT, "app", "api", "snmp.py"),
    f"{REMOTE_APP}/app/api/snmp.py",
)
print("Uploaded app/api/snmp.py")

sftp.close()

# ── 3. Clear old data ───────────────────────────────────────────────────────
print("\n── Clearing old data ──")
run("""python3 << 'PYEOF'
import sqlite3

# Clear control-plane alert events
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
deleted = conn.execute('DELETE FROM alert_events').rowcount
conn.commit()
conn.close()
print(f'alert_events: {deleted} rows deleted')

# Clear time-series data and VACUUM
ts = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')
p = ts.execute('DELETE FROM snmp_poll_results').rowcount
t = ts.execute('DELETE FROM snmp_traps').rowcount
ts.commit()
ts.execute('VACUUM')
ts.close()
print(f'snmp_poll_results: {p} rows deleted')
print(f'snmp_traps: {t} rows deleted')
print('VACUUM done')
PYEOF
""")

# Truncate log
run("truncate -s 0 /mnt/software/logs/pktsnmp.log")
print("Log truncated.")

# ── 4. Restart service ──────────────────────────────────────────────────────
print("\n── Restarting pktsnmp ──")
run("sudo systemctl restart pktsnmp")
time.sleep(6)
run("systemctl is-active pktsnmp")
print()
run("journalctl -u pktsnmp -n 8 --no-pager -o cat 2>/dev/null | grep -v Consumed")

# ── 5. Verify migration applied + storage init ──────────────────────────────
print("\n── Verifying ──")
run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
cols = [r[1] for r in conn.execute('PRAGMA table_info(alert_events)').fetchall()]
print('alert_events columns:', cols)
migs = conn.execute("SELECT name FROM _migrations ORDER BY applied_at DESC LIMIT 5").fetchall()
print('last migrations:', [m[0] for m in migs])
conn.close()
PYEOF
""")

# ── 6. Snapshot 1 of devices + row counts ───────────────────────────────────
print("\n── Snapshot 1 (waiting 60s for data to flow) ──")
run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print('server time:', now)
rows = conn.execute('SELECT name, collector_id, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
for r in rows:
    print(f'  coll={r[1]} {r[0][:28]:28s} {r[2]:8s} {r[3]}')
conn.close()
ts = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')
cnt = ts.execute('SELECT COUNT(*) FROM snmp_poll_results').fetchone()[0]
print(f'snmp_poll_results rows: {cnt}')
ts.close()
PYEOF
""")

print("\nwaiting 60s...")
time.sleep(60)

print("\n── Snapshot 2 ──")
run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print('server time:', now)
rows = conn.execute('SELECT name, collector_id, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
for r in rows:
    print(f'  coll={r[1]} {r[0][:28]:28s} {r[2]:8s} {r[3]}')
conn.close()
ts = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')
cnt = ts.execute('SELECT COUNT(*) FROM snmp_poll_results').fetchone()[0]
print(f'snmp_poll_results rows: {cnt}')
ts.close()
PYEOF
""")

print("\n── Last 20 log lines ──")
run("tail -20 /mnt/software/logs/pktsnmp.log")

c.close()
print("\nDone.")
