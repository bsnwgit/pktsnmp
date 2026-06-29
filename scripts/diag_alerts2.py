#!/usr/bin/env python3
"""Check actual alert_rules/events schema and DuckDB state."""
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH = r"C:\Users\USER\.ssh\your-key.pem"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)

def run(cmd, label=None):
    if label: print(f"\n=== {label} ===")
    _, o, e = c.exec_command(cmd, timeout=30)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("ERR:", err)

run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')

# All table schemas
print('TABLES:')
for t in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\"):
    print(' ', t[0])
    for col in conn.execute(f'PRAGMA table_info({t[0]})'):
        print('   ', col[1], col[2])
" """, "FULL SCHEMA")

run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT * FROM alert_rules LIMIT 20').fetchall()
for r in rows: print(dict(r))
if not rows: print('(empty)')
" """, "ALERT RULES CONTENT")

run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT * FROM alert_events ORDER BY id DESC LIMIT 10').fetchall()
for r in rows: print(dict(r))
if not rows: print('(empty)')
" """, "ALERT EVENTS CONTENT")

run("ls -lh /mnt/software/pktsnmp/*.duckdb 2>/dev/null || echo 'no .duckdb files'", "DUCKDB FILES")
run("systemctl is-active pktsnmp && journalctl -u pktsnmp -n 5 --no-pager 2>/dev/null | tail -8", "SERVICE STATUS")

c.close()
