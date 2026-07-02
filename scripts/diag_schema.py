#!/usr/bin/env python3

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"PATH\TO\YOUR-KEY.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("SERVER-IP", username="ssh-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    return o.read().decode("utf-8", errors="replace").strip()

# alert_events schema
print("=== alert_events columns ===")
print(run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
rows = conn.execute("PRAGMA table_info(alert_events)").fetchall()
for r in rows:
    print(f'  col {r[0]}: {r[1]:20s} {r[2]}')
PYEOF
"""))

# When did service last restart?
print("\n=== Service started at ===")
print(run("systemctl show pktsnmp --property=ActiveEnterTimestamp"))

# When was storage_backend setting written?
print("\n=== storage_backend setting ===")
print(run("""python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
rows = conn.execute("SELECT key, value, updated_at FROM settings WHERE key='storage_backend'").fetchall()
for r in rows:
    print(f'  key={r[0]}  value={r[1]}  updated_at={r[2]}')
PYEOF
"""))

# Tail current log for storage init message
print("\n=== Storage init log (grep) ===")
print(run("grep -i 'storage backend\\|storage_backend\\|init_storage' /mnt/software/logs/pktsnmp.log | tail -5"))

# Tail log for most recent 500 chars
print("\n=== LATEST LOG (last 30 lines) ===")
print(run("tail -30 /mnt/software/logs/pktsnmp.log"))

c.close()
