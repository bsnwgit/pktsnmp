#!/usr/bin/env python3
"""
deploy_fix_async_ssh.py

Fixes:
  1. collector_push.py  — push_config + preview_config made synchronous
  2. snmp.py            — all 3 Paramiko endpoints use asyncio.to_thread
  3. Collectors.tsx     — defensive JSON handling in syncCollector / testSSH / PreviewModal

This prevents the "JSON.parse: unexpected character" error caused by blocking
Paramiko SSH code running in the asyncio event loop and dropping the HTTP response.
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

BACKEND_FILES = [
    ("app/snmp/collector_push.py", "app/snmp/collector_push.py"),
    ("app/api/snmp.py",            "app/api/snmp.py"),
]

FRONTEND_FILES = [
    ("frontend/src/pages/Collectors.tsx", "frontend/src/pages/Collectors.tsx"),
]


def run(ssh, cmd, check=True, timeout=120):
    print(f"  $ {cmd[:100]}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc  = stdout.channel.recv_exit_status()
    if out.strip(): print(f"    {out.strip()}")
    if err.strip(): print(f"    STDERR: {err.strip()}", file=sys.stderr)
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {cmd[:80]}")
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

    print("[1/3] Uploading backend fixes...")
    upload(sftp, BACKEND_FILES)

    print("\n[2/3] Uploading frontend fixes...")
    upload(sftp, FRONTEND_FILES)
    sftp.close()

    # Restart to pick up Python changes (no migration needed)
    print(f"\n      Restarting backend...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(5)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() != "active":
        print(f"  ERROR: status='{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 30 --no-pager", check=False)
        ssh.close()
        sys.exit(1)
    print("      Backend active ✓")

    print(f"\n[3/3] Building frontend on O2...")
    run(ssh, f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=180)

    print(f"\n      Restarting to serve new frontend...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    print(f"      Service: {out.strip()}")
    if out.strip() != "active":
        run(ssh, f"journalctl -u {SERVICE} -n 20 --no-pager", check=False)

    ssh.close()
    print("\n[deploy] Done.")
    print("  → Paramiko SSH now runs in thread pool (event loop no longer blocked)")
    print("  → syncCollector / testSSH / Preview show real error messages on failure")
    print("  → Go to Collectors → Test SSH, then ↑ Sync to push device config")


if __name__ == "__main__":
    main()
