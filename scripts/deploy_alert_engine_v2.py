#!/usr/bin/env python3
"""
Deploy real alert engine + margin fix + dashboard status dots.

Backend changes (no frontend build needed for these):
  migrations/014_alert_resolved.sql  -- adds resolved_at to alert_events
  app/alerts/engine.py               -- real device_down rule evaluation
  app/api/alerts.py                  -- resolved_at + active filter + device join

Frontend changes (build required):
  frontend/src/pages/OidCatalog.tsx  -- remove max-w-5xl mx-auto
  frontend/src/pages/Collectors.tsx  -- remove max-w-5xl mx-auto
  frontend/src/pages/Devices.tsx     -- remove max-w-6xl mx-auto
  frontend/src/pages/Dashboard.tsx   -- status dots on Org/Group/Site nodes
"""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST      = "SERVER-IP"
USER      = "ssh-user"
KEY_PATH  = r"PATH\TO\YOUR-KEY.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=key, timeout=15)
print("Connected.")

def run(cmd, timeout=300):
    print(f"  $ {cmd[:120]}")
    _, o, e = client.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    rc  = o.channel.recv_exit_status()
    if out: print("   ", out[-800:])
    if err and rc != 0: print("   STDERR:", err[-300:])
    return rc

# 1. Backup
print("\n[1/4] Backup...")
ts = time.strftime("%Y%m%d_%H%M%S")
run(f"cp -a {REMOTE_APP} /mnt/software/pktsnmp_backups/pre_alert_engine_{ts} 2>/dev/null || true")

# 2. Upload files
print("\n[2/4] Uploading files...")
sftp = client.open_sftp()
files = [
    ("migrations/014_alert_resolved.sql",  f"{REMOTE_APP}/migrations/014_alert_resolved.sql"),
    ("app/alerts/engine.py",               f"{REMOTE_APP}/app/alerts/engine.py"),
    ("app/api/alerts.py",                  f"{REMOTE_APP}/app/api/alerts.py"),
    ("frontend/src/pages/OidCatalog.tsx",  f"{REMOTE_APP}/frontend/src/pages/OidCatalog.tsx"),
    ("frontend/src/pages/Collectors.tsx",  f"{REMOTE_APP}/frontend/src/pages/Collectors.tsx"),
    ("frontend/src/pages/Devices.tsx",     f"{REMOTE_APP}/frontend/src/pages/Devices.tsx"),
    ("frontend/src/pages/Dashboard.tsx",   f"{REMOTE_APP}/frontend/src/pages/Dashboard.tsx"),
]
for local_rel, remote in files:
    sftp.put(os.path.join(LOCAL_ROOT, local_rel), remote)
    print(f"  up {local_rel}")
sftp.close()

# 3. Build frontend
print("\n[3/4] Building frontend...")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build')

# 4. Clear ghost alert events (all stale events fired before this deploy)
print("\n[4/5] Clearing ghost alert events...")
run(f"""python3 -c "
import sqlite3
conn = sqlite3.connect('{REMOTE_APP}/pktsnmp.db')
cur = conn.execute('DELETE FROM alert_events')
print('Deleted', cur.rowcount, 'stale alert events')
conn.commit()
conn.close()
" """)

# 5. Restart
print("\n[5/5] Restarting service...")
run("sudo systemctl restart pktsnmp")
time.sleep(4)
run("systemctl is-active pktsnmp")
run("journalctl -u pktsnmp -n 8 --no-pager | grep -iE 'alert|migration|error' || true")
client.close()
print("\nDone.")
