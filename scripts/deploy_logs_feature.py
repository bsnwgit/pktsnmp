#!/usr/bin/env python3
"""
deploy_logs_feature.py — Deploy the in-app logging feature to O2.

Uploads changed files via SFTP, restarts the backend (migration runs on
startup), builds the React frontend on O2, then restarts again.

Usage:
    python scripts/deploy_logs_feature.py

Requirements:
    pip install paramiko
"""

import os
import sys
import time
import paramiko
sys.stdout.reconfigure(encoding='utf-8')

# ── Config ─────────────────────────────────────────────────────────────────────
HOST        = "172.23.80.5"
PORT        = 22
USER        = "ec2-user"
KEY_PATH    = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
LOCAL_ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP  = "/mnt/software/pktsnmp"
SERVICE     = "pktsnmp"

# Files to upload: (local relative path, remote relative path)
BACKEND_FILES = [
    ("migrations/004_app_logs.sql",  "migrations/004_app_logs.sql"),
    ("app/logging_handler.py",       "app/logging_handler.py"),
    ("app/api/logs.py",              "app/api/logs.py"),
    ("app/main.py",                  "app/main.py"),
]

FRONTEND_FILES = [
    ("frontend/src/pages/Logs.tsx",           "frontend/src/pages/Logs.tsx"),
    ("frontend/src/api/client.ts",            "frontend/src/api/client.ts"),
    ("frontend/src/App.tsx",                  "frontend/src/App.tsx"),
    ("frontend/src/components/Layout.tsx",    "frontend/src/components/Layout.tsx"),
]
# ──────────────────────────────────────────────────────────────────────────────


def run(ssh: paramiko.SSHClient, cmd: str, check: bool = True, timeout: int = 300):
    print(f"  $ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode()
    err = stderr.read().decode()
    rc  = stdout.channel.recv_exit_status()
    if out.strip():
        print(f"    {out.strip()}")
    if err.strip():
        print(f"    STDERR: {err.strip()}", file=sys.stderr)
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {cmd}")
    return rc, out, err


def upload(sftp: paramiko.SFTPClient, files: list[tuple[str, str]]):
    for local_rel, remote_rel in files:
        local  = os.path.join(LOCAL_ROOT, local_rel)
        remote = f"{REMOTE_APP}/{remote_rel}"
        print(f"  ↑ {local_rel}")
        sftp.put(local, remote)


def main():
    print(f"[deploy] Connecting to {USER}@{HOST}…")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
    ssh.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15, banner_timeout=15)

    print(f"[deploy] Connected.\n")
    sftp = ssh.open_sftp()

    # ── 1. Upload backend files ────────────────────────────────────────────────
    print("[1/4] Uploading backend files…")
    upload(sftp, BACKEND_FILES)

    # ── 2. Restart backend (migration runs on startup) ─────────────────────────
    print(f"\n[2/4] Restarting {SERVICE} (runs migration 004_app_logs)…")
    run(ssh, f"sudo systemctl restart {SERVICE}")
    time.sleep(3)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() != "active":
        print("      ERROR: service not active. Checking logs…", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 40 --no-pager", check=False)
        sftp.close(); ssh.close(); sys.exit(1)
    print("      Backend active ✓")

    # ── 3. Upload frontend files + build ──────────────────────────────────────
    print("\n[3/4] Uploading frontend files…")
    upload(sftp, FRONTEND_FILES)
    sftp.close()

    NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
    print("\n      Installing npm deps on O2…")
    run(ssh, f'{NVM} && cd {REMOTE_APP}/frontend && npm install --prefer-offline', timeout=180)
    print("      Building frontend on O2 (npm run build)…")
    run(ssh, f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
    print("      Build complete ✓")

    # ── 4. Final service restart to serve new dist ────────────────────────────
    print(f"\n[4/4] Restarting {SERVICE} to serve new frontend…")
    run(ssh, f"sudo systemctl restart {SERVICE}")
    time.sleep(2)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() == "active":
        print("      Service active ✓")
    else:
        print(f"      WARNING: status = '{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 30 --no-pager", check=False)
        ssh.close(); sys.exit(1)

    ssh.close()
    print(f"\n[deploy] Done. pktSNMP running at http://{HOST}:8767")
    print("         Navigate to /logs to verify the new page.")


if __name__ == "__main__":
    main()
