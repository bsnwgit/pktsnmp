#!/usr/bin/env python3
"""
deploy_collector_ssh.py — Deploy remote collector SSH config push feature.

Changes deployed:
  migrations/007_collector_ssh.sql    -- SSH fields on collectors, otelcol_pipeline on devices
  app/snmp/otelcol_config.py          -- SNMP receiver block generator
  app/snmp/collector_push.py          -- SSH push + YAML patch
  app/api/snmp.py                     -- sync/preview/test-ssh endpoints, SSH CRUD, otelcol_pipeline

Frontend changes:
  frontend/src/pages/Collectors.tsx   -- SSH config UI, sync controls, preview, test-ssh
  frontend/src/pages/Devices.tsx      -- otelcol_pipeline field

Requires frontend rebuild (npm run build on O2).
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

HOST       = "SERVER-IP"
PORT       = 22
USER       = "ssh-user"
KEY_PATH   = r"PATH\TO\YOUR-KEY.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

BACKEND_FILES = [
    ("migrations/007_collector_ssh.sql",  "migrations/007_collector_ssh.sql"),
    ("app/snmp/otelcol_config.py",         "app/snmp/otelcol_config.py"),
    ("app/snmp/collector_push.py",          "app/snmp/collector_push.py"),
    ("app/api/snmp.py",                     "app/api/snmp.py"),
]

FRONTEND_FILES = [
    ("frontend/src/pages/Collectors.tsx",  "frontend/src/pages/Collectors.tsx"),
    ("frontend/src/pages/Devices.tsx",     "frontend/src/pages/Devices.tsx"),
]


def run(ssh, cmd, check=True, timeout=120):
    print(f"  $ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode()
    err = stderr.read().decode()
    rc  = stdout.channel.recv_exit_status()
    if out.strip(): print(f"    {out.strip()}")
    if err.strip(): print(f"    STDERR: {err.strip()}", file=sys.stderr)
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {cmd}")
    return rc, out, err


def upload(sftp, files):
    for local_rel, remote_rel in files:
        local  = os.path.join(LOCAL_ROOT, local_rel)
        remote = f"{REMOTE_APP}/{remote_rel}"
        print(f"  up {local_rel}")
        sftp.put(local, remote)


def main():
    print(f"[deploy] Connecting to {USER}@{HOST}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
    ssh.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15)
    print("[deploy] Connected.\n")

    sftp = ssh.open_sftp()

    # 1. Upload backend files
    print("[1/4] Uploading backend files...")
    upload(sftp, BACKEND_FILES)

    # 2. Upload frontend source
    print("\n[2/4] Uploading frontend source...")
    upload(sftp, FRONTEND_FILES)
    sftp.close()

    # 3. First restart — runs migration 007 (adds SSH columns + otelcol_pipeline)
    print(f"\n[3/4] Restarting backend (migration 007 runs on startup)...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(5)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() != "active":
        print(f"      ERROR: status='{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 50 --no-pager", check=False)
        ssh.close()
        sys.exit(1)
    print("      Backend active ✓")

    # 4. Frontend build on O2
    print(f"\n[4/4] Building frontend on O2...")
    run(ssh, f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=180)

    # Final restart to serve new dist
    print(f"\n      Restarting to serve new frontend...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    status = out.strip()
    print(f"      Service: {status}")
    if status != "active":
        run(ssh, f"journalctl -u {SERVICE} -n 30 --no-pager", check=False)

    ssh.close()
    print(f"\n[deploy] Done.")
    print("  → Collectors page now has: SSH config, Sync, Preview, Test SSH")
    print("  → Devices form now has: otelcol_pipeline selector")
    print("  → Next: configure SSH creds in Collectors UI, then Sync each remote collector")


if __name__ == "__main__":
    main()
