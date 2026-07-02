#!/usr/bin/env python3
"""Diagnose alert/data pipeline on O2."""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH = r"PATH\TO\YOUR-KEY.pem"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("SERVER-IP", username="ssh-user", pkey=key, timeout=15)
print("Connected.\n")

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=30)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("STDERR:", err, file=sys.stderr)

print("=== RECENT LOG (errors/warnings) ===")
run("grep -E 'ERROR|WARNING|Exception|Traceback' /mnt/software/logs/pktsnmp.log | tail -30")

print("\n=== ALERT RULES ===")
run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, name, enabled, metric, condition, threshold FROM alert_rules').fetchall()
for r in rows:
    print(dict(r))
" """)

print("\n=== RECENT ALERT EVENTS ===")
run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, alert_rule_id, device_id, fired_at, acked_at FROM alert_events ORDER BY fired_at DESC LIMIT 10').fetchall()
for r in rows:
    print(dict(r))
if not rows:
    print('(none)')
" """)

print("\n=== DEVICE STATUS ===")
run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, name, ip, status, enabled, last_seen, last_error FROM devices').fetchall()
for r in rows:
    print(dict(r))
" """)

print("\n=== OTELCOL PROCESS ===")
run("pgrep -a otelcol 2>/dev/null || echo 'otelcol not running'")

print("\n=== COLLECTORS TABLE ===")
run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, name, status, last_seen FROM collectors').fetchall()
for r in rows:
    print(dict(r))
" """)

print("\n=== RECENT POLL RESULTS (DuckDB) ===")
run("""python3 -c "
try:
    import duckdb
    conn = duckdb.connect('/mnt/software/pktsnmp/snmp_data.duckdb', read_only=True)
    rows = conn.execute('SELECT * FROM snmp_poll_results ORDER BY collected_at DESC LIMIT 5').fetchall()
    for r in rows:
        print(r)
    if not rows:
        print('(no poll results)')
except Exception as e:
    print('DuckDB error:', e)
" """)

c.close()
