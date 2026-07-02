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
    _, o, e = c.exec_command(cmd, timeout=20)
    return o.read().decode("utf-8", errors="replace").strip()

# Collector heartbeats
print("=== COLLECTOR last_seen ===")
print(run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute(\"SELECT datetime('now')\").fetchone()[0]
rows = conn.execute('SELECT name, status, last_seen FROM collectors ORDER BY id').fetchall()
print('now:', now)
for r in rows: print(f'  {r[0]:20s} {r[1]:8s} {r[2]}')
" """))

# Check if ingest endpoint updates last_seen in snmp.py
print("\n=== DOES INGEST UPDATE devices.last_seen? ===")
print(run("grep -n 'last_seen' /mnt/software/pktsnmp/app/api/snmp.py | grep -i 'update\\|UPDATE\\|ingest\\|device' | head -10"))

# Live HTTP access log - any recent ingest hits?
print("\n=== RECENT INGEST HITS (access log) ===")
print(run("grep -i 'otlp\\|ingest\\|metrics' /mnt/software/logs/pktsnmp.log | tail -10"))

# What does SQLite ts storage look like?
print("\n=== SQLITE TIME-SERIES DB ===")
print(run("ls -lh /mnt/software/pktsnmp/snmp_timeseries.db 2>/dev/null || echo 'NOT FOUND'"))
print(run("""python3 -c "
import sqlite3
try:
    conn = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')
    tables = conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()
    print('tables:', [t[0] for t in tables])
    for t in tables:
        row = conn.execute(f'SELECT COUNT(*) FROM {t[0]}').fetchone()
        print(f'  {t[0]}: {row[0]} rows')
except Exception as e:
    print('ERROR:', e)
" """))

c.close()
