#!/usr/bin/env python3

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import paramiko, sys, time
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"PATH\TO\YOUR-KEY.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("SERVER-IP", username="ssh-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=30)
    return o.read().decode("utf-8", errors="replace").strip()

# Collectors
print("=== COLLECTORS ===")
print(run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print('server time:', now)
rows = conn.execute('SELECT id, name, status, last_seen FROM collectors ORDER BY id').fetchall()
print('count:', len(rows))
for r in rows:
    print(f'  id={r[0]} {r[1]:25s} {r[2]:10s} {r[3]}')
PYEOF
"""))

# Devices + last_seen
print("\n=== DEVICES last_seen SNAPSHOT 1 ===")
print(run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print('server time:', now)
rows = conn.execute('SELECT name, collector_id, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
for r in rows:
    print(f'  coll={r[1]} {r[0][:28]:28s} {r[2]:8s} {r[3]}')
PYEOF
"""))

# Check if _do_ingest_otlp updates devices.last_seen
print("\n=== INGEST: does it update devices.last_seen? ===")
print(run("grep -n 'last_seen\\|UPDATE devices' /mnt/software/pktsnmp/app/api/snmp.py | grep -i 'update\\|UPDATE' | head -15"))

# Last 20 lines of the actual log
print("\n=== LAST 20 LOG LINES ===")
print(run("tail -20 /mnt/software/logs/pktsnmp.log"))

# snmp_timeseries.db row counts
print("\n=== snmp_timeseries.db tables ===")
print(run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')
tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print('tables:', [t[0] for t in tables])
for t in tables:
    cnt = conn.execute(f'SELECT COUNT(*) FROM {t[0]}').fetchone()[0]
    latest = conn.execute(f'SELECT MAX(ts) FROM {t[0]}').fetchone()[0] if cnt else 'n/a'
    print(f'  {t[0]}: {cnt} rows  latest={latest}')
PYEOF
"""))

c.close()
