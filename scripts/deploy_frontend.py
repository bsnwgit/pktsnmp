#!/usr/bin/env python3
"""
deploy_frontend.py — Build React frontend on O2 and restart pktSNMP service.

Usage:
    python scripts/deploy_frontend.py

Requirements:
    pip install paramiko
    SSH key or password auth to 172.23.80.5

IMPORTANT:
  - SentinelOne EDR blocks system ssh.exe on Windows. This script uses Paramiko only.
  - Never build the frontend on Windows — node_modules there is Windows-only
    and lacks the Linux rollup native binary. This script builds on O2.
  - ONE script, ONE run, NO retry loops — hammering the connection locks the server.
"""

import os
import sys
import time
import paramiko

# ── Config ─────────────────────────────────────────────────────────────────────
HOST        = "172.23.80.5"
PORT        = 22
USER        = "robert.barnett"
KEY_PATH    = os.path.expanduser("~/.ssh/id_rsa")   # adjust as needed
REMOTE_APP  = "/mnt/software/pktsnmp"
SERVICE     = "pktsnmp"
# ──────────────────────────────────────────────────────────────────────────────

def run(ssh: paramiko.SSHClient, cmd: str, check: bool = True, timeout: int = 300) -> tuple[int, str, str]:
    print(f"  $ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
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


def main():
    print(f"[deploy] Connecting to {USER}@{HOST}…")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        ssh.connect(HOST, port=PORT, username=USER, key_filename=KEY_PATH, timeout=15)
    except paramiko.AuthenticationException:
        print("[deploy] Key auth failed, trying password…")
        import getpass
        pw = getpass.getpass(f"Password for {USER}@{HOST}: ")
        ssh.connect(HOST, port=PORT, username=USER, password=pw, timeout=15)

    print(f"[deploy] Connected. Deploying to {REMOTE_APP}…\n")

    # ── 1. Sync source ─────────────────────────────────────────────────────────
    # NOTE: rsync is preferred for large repos. If unavailable, use git pull.
    print("[1/4] Syncing source (git pull)…")
    run(ssh, f"cd {REMOTE_APP} && git pull --ff-only")

    # ── 2. Install npm dependencies ────────────────────────────────────────────
    print("\n[2/4] Installing npm dependencies…")
    run(ssh, f"cd {REMOTE_APP}/frontend && npm ci --prefer-offline", timeout=180)

    # ── 3. Build frontend ──────────────────────────────────────────────────────
    print("\n[3/4] Building frontend (vite build)…")
    run(ssh, f"cd {REMOTE_APP}/frontend && npm run build", timeout=300)
    print("      Build complete.")

    # ── 4. Restart service ────────────────────────────────────────────────────
    print(f"\n[4/4] Restarting {SERVICE} service…")
    run(ssh, f"sudo systemctl restart {SERVICE}")
    time.sleep(2)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    status = out.strip()
    if status == "active":
        print(f"      Service is active ✓")
    else:
        print(f"      WARNING: service status = '{status}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 30 --no-pager", check=False)
        sys.exit(1)

    ssh.close()
    print(f"\n[deploy] Done. pktSNMP is running at http://{HOST}:8767")


if __name__ == "__main__":
    main()
