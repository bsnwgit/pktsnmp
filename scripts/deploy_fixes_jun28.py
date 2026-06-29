#!/usr/bin/env python3
"""
deploy_fixes_jun28.py

Deploys:
  - snmp.py: route ordering fix, ha_role, community masking, cred_community removed
  - client.ts: ha_role in SnmpDeviceNode
  - Dashboard.tsx: UTC timestamp fix, ha_role badge
  - Devices.tsx: ha_role form/table, UTC timestamp fix, community display removed

NO migration needed (006_ha_role.sql already applied on server).
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

FILES = [
    ("app/api/snmp.py",                   "app/api/snmp.py"),
    ("frontend/src/api/client.ts",        "frontend/src/api/client.ts"),
    ("frontend/src/pages/Dashboard.tsx",  "frontend/src/pages/Dashboard.tsx"),
    ("frontend/src/pages/Devices.tsx",    "frontend/src/pages/Devices.tsx"),
]

# ── Connect ────────────────────────────────────────────────────────────────────
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
print("[1/3] Uploading changed files…")
sftp = client.open_sftp()
for local_rel, remote_rel in FILES:
    local_path  = os.path.join(LOCAL_ROOT, local_rel)
    remote_path = f"{REMOTE_APP}/{remote_rel}"
    print(f"  ↑ {remote_rel}")
    sftp.put(local_path, remote_path)
sftp.close()
print("      Upload complete.\n")

# ── 2. Build frontend ──────────────────────────────────────────────────────────
print("[2/3] Building frontend on O2…")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
print("      Build complete.\n")

# ── 3. Restart service ─────────────────────────────────────────────────────────
print(f"[3/3] Restarting {SERVICE}…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(4)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print(f"      Service active ✓")
else:
    print(f"!! Service status: '{out.strip()}'", file=sys.stderr)
    run(f"tail -40 /mnt/software/logs/pktsnmp.log", check=False)
    client.close()
    sys.exit(1)

client.close()
print(f"\n=== Done. pktSNMP running at http://{HOST}:8767 ===")
