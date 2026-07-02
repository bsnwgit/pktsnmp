#!/usr/bin/env python3
"""Check server DB schema — one-shot diagnostic."""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH = r"PATH\TO\YOUR-KEY.pem"
HOST, USER = "SERVER-IP", "ssh-user"

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, pkey=key, timeout=15)

script = """\
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
print("=== devices columns ===")
for r in conn.execute("PRAGMA table_info(devices)"):
    print(r)
print("\\n=== collectors columns ===")
for r in conn.execute("PRAGMA table_info(collectors)"):
    print(r)
print("\\n=== sample devices (id/name/ha_role/status/last_seen) ===")
try:
    for r in conn.execute("SELECT id, name, ha_role, status, last_seen FROM devices LIMIT 5"):
        print(r)
except Exception as e:
    print("ha_role query failed:", e)
print("\\n=== applied migrations ===")
for r in conn.execute("SELECT filename FROM _migrations ORDER BY filename"):
    print(r[0])
conn.close()
"""

sftp = c.open_sftp()
with sftp.open('/tmp/check_schema.py', 'w') as f:
    f.write(script)
sftp.close()

_, o, e = c.exec_command('python3 /tmp/check_schema.py', timeout=15)
print(o.read().decode('utf-8', errors='replace'))
err = e.read().decode('utf-8', errors='replace')
if err:
    print("STDERR:", err)
c.close()
