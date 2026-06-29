#!/usr/bin/env python3
"""
deploy_parent_device.py

Deploys the parent_device_id topology feature:
  1. SFTP changed files to O2
  2. Run migration 005_parent_device.sql against pktsnmp.db
  3. Build frontend on O2 (NVM node)
  4. Restart pktsnmp service

ONE run, no retry loops.
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST     = "172.23.80.5"
PORT     = 22
USER     = "ec2-user"
KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"

LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
DB_PATH    = "/mnt/software/pktsnmp/pktsnmp.db"

# Files to upload (local_relative, remote_relative)
FILES = [
    ("migrations/005_parent_device.sql",          "migrations/005_parent_device.sql"),
    ("app/api/snmp.py",                            "app/api/snmp.py"),
    ("frontend/src/api/client.ts",                 "frontend/src/api/client.ts"),
    ("frontend/src/pages/Dashboard.tsx",           "frontend/src/pages/Dashboard.tsx"),
    ("frontend/src/pages/Devices.tsx",             "frontend/src/pages/Devices.tsx"),
]

# ── Connect ────────────────────────────────────────────────────────────────────
print(f"=== Connecting to {USER}@{HOST} ===")
key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15, banner_timeout=15)
print(f"Connected.\n")

def run(cmd, timeout=300, check=True):
    print(f"  $ {cmd[:140]}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out:
        print(f"    {out}")
    if err and rc != 0:
        print(f"    STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        print(f"\n!! Failed (rc={rc}): {cmd}", file=sys.stderr)
        client.close()
        sys.exit(1)
    return rc, out

# ── 1. SFTP files ──────────────────────────────────────────────────────────────
print("[1/4] Uploading changed files…")
sftp = client.open_sftp()
for local_rel, remote_rel in FILES:
    local_path  = os.path.join(LOCAL_ROOT, local_rel)
    remote_path = f"{REMOTE_APP}/{remote_rel}"
    print(f"  ↑ {remote_rel}")
    sftp.put(local_path, remote_path)
sftp.close()
print("      Upload complete.\n")

# ── 2. Run migration ───────────────────────────────────────────────────────────
print("[2/4] Running migration 005_parent_device.sql…")
# Use Python's built-in sqlite3 module (sqlite3 CLI not available on O2)
# Write migration script to /tmp to avoid shell quoting issues
migration_script = f"""\
import sqlite3, sys
DB = "{DB_PATH}"
conn = sqlite3.connect(DB)
cols = [r[1] for r in conn.execute("PRAGMA table_info(devices)")]
already_col = "parent_device_id" in cols
if not already_col:
    conn.execute("ALTER TABLE devices ADD COLUMN parent_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL")
    conn.commit()
# Always record in _migrations so init_db() skips it (INSERT OR IGNORE = idempotent)
conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES ('005_parent_device.sql')")
conn.commit()
cols2 = [r[1] for r in conn.execute("PRAGMA table_info(devices)")]
ok = "parent_device_id" in cols2
print("column present:", ok, "| was already there:", already_col)
conn.close()
sys.exit(0 if ok else 1)
"""
sftp = client.open_sftp()
with sftp.open('/tmp/migrate_005.py', 'w') as f:
    f.write(migration_script)
sftp.close()
rc, out = run("python3 /tmp/migrate_005.py", check=False)
if rc == 0:
    print("      Migration verified — parent_device_id column present ✓\n")
else:
    print("!! Migration failed — parent_device_id column not found", file=sys.stderr)
    client.close()
    sys.exit(1)

# ── 3. Build frontend ──────────────────────────────────────────────────────────
print("[3/4] Building frontend on O2…")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm ci --prefer-offline', timeout=180)
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
print("      Build complete.\n")

# ── 4. Restart service ─────────────────────────────────────────────────────────
print(f"[4/4] Restarting {SERVICE}…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(3)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print(f"      Service active ✓")
else:
    print(f"!! Service status: '{out.strip()}'", file=sys.stderr)
    run(f"journalctl -u {SERVICE} -n 40 --no-pager", check=False)
    client.close()
    sys.exit(1)

client.close()
print(f"\n=== Done. pktSNMP running at http://{HOST}:8767 ===")
