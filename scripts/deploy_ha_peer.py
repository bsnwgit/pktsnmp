#!/usr/bin/env python3
"""
deploy_ha_peer.py

Deploys ha_peer_id HA pair topology feature:
  - migrations/009_ha_peer.sql  (adds ha_peer_id column, recorded in _migrations)
  - app/api/snmp.py             (ha_peer_id in models, CRUD, tree redirect)
  - frontend/src/pages/Devices.tsx  (ha_peer_id selector in form)

ONE run, no retry loops.
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

HOST     = "SERVER-IP"
PORT     = 22
USER     = "ssh-user"
KEY_PATH = r"PATH\TO\YOUR-KEY.pem"

LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
DB_PATH    = "/mnt/software/pktsnmp/pktsnmp.db"

FILES = [
    ("migrations/009_ha_peer.sql",        "migrations/009_ha_peer.sql"),
    ("app/api/snmp.py",                   "app/api/snmp.py"),
    ("frontend/src/pages/Devices.tsx",    "frontend/src/pages/Devices.tsx"),
]

print(f"=== Connecting to {USER}@{HOST} ===")
key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15, banner_timeout=15)
print("Connected.\n")

def run(cmd, timeout=300, check=True):
    print(f"  $ {cmd[:140]}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out: print(f"    {out}")
    if err and rc != 0: print(f"    STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        print(f"\n!! Failed (rc={rc}): {cmd}", file=sys.stderr)
        client.close(); sys.exit(1)
    return rc, out

# ── 1. Upload files ────────────────────────────────────────────────────────────
print("[1/4] Uploading files…")
sftp = client.open_sftp()
for local_rel, remote_rel in FILES:
    sftp.put(os.path.join(LOCAL_ROOT, local_rel), f"{REMOTE_APP}/{remote_rel}")
    print(f"  ↑ {remote_rel}")
sftp.close()
print("      Done.\n")

# ── 2. Run migration (write to /tmp to avoid quoting issues) ──────────────────
print("[2/4] Running migration 009_ha_peer.sql…")
migration_script = f"""\
import sqlite3, sys
conn = sqlite3.connect("{DB_PATH}")
cols = [r[1] for r in conn.execute("PRAGMA table_info(devices)")]
if "ha_peer_id" not in cols:
    conn.execute("ALTER TABLE devices ADD COLUMN ha_peer_id INTEGER REFERENCES devices(id) ON DELETE SET NULL")
    conn.commit()
conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES ('009_ha_peer.sql')")
conn.commit()
ok = "ha_peer_id" in [r[1] for r in conn.execute("PRAGMA table_info(devices)")]
print("ha_peer_id present:", ok)
conn.close()
sys.exit(0 if ok else 1)
"""
sftp = client.open_sftp()
with sftp.open('/tmp/migrate_009.py', 'w') as f:
    f.write(migration_script)
sftp.close()
rc, _ = run("python3 /tmp/migrate_009.py", check=False)
if rc != 0:
    print("!! Migration failed", file=sys.stderr)
    client.close(); sys.exit(1)
print("      Migration OK.\n")

# ── 3. Build frontend ──────────────────────────────────────────────────────────
print("[3/4] Building frontend on O2…")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
print("      Build complete.\n")

# ── 4. Restart service ─────────────────────────────────────────────────────────
print(f"[4/4] Restarting {SERVICE}…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(4)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print("      Service active ✓")
else:
    run("tail -40 /mnt/software/logs/pktsnmp.log", check=False)
    client.close(); sys.exit(1)

client.close()
print(f"\n=== Done. pktSNMP at http://{HOST}:8767 ===")
