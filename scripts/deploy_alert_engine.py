#!/usr/bin/env python3
"""
deploy_alert_engine.py -- Deploy Phase 4 alert engine to O2.

Changes deployed:
  migrations/005_alert_resolved.sql  -- adds resolved_at to alert_events
  app/alerts/engine.py               -- full alert engine implementation
  app/snmp/local_collector.py        -- wires engine into trap/poll handlers
  app/snmp/poll_engine.py            -- adds failure_handler callback
  app/api/alerts.py                  -- adds resolved_at + parses details JSON
  app/main.py                        -- passes db_path to engine, wires LocalCollector

No frontend changes -- no npm build needed.

Usage:
    python scripts/deploy_alert_engine.py
"""


# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import os
import sys
import time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST       = "SERVER-IP"
PORT       = 22
USER       = "ssh-user"
KEY_PATH   = r"PATH\TO\YOUR-KEY.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"

BACKEND_FILES = [
    ("migrations/005_alert_resolved.sql", "migrations/005_alert_resolved.sql"),
    ("app/alerts/engine.py",              "app/alerts/engine.py"),
    ("app/snmp/local_collector.py",       "app/snmp/local_collector.py"),
    ("app/snmp/poll_engine.py",           "app/snmp/poll_engine.py"),
    ("app/api/alerts.py",                 "app/api/alerts.py"),
    ("app/main.py",                       "app/main.py"),
]


def run(ssh, cmd, check=True, timeout=120):
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
    ssh.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15, banner_timeout=15)
    print("[deploy] Connected.\n")

    sftp = ssh.open_sftp()

    # 1. Backup
    print("[1/3] Taking server-side backup...")
    ts = time.strftime("%Y%m%d_%H%M%S")
    run(ssh, f"cp -a {REMOTE_APP} /mnt/software/pktsnmp_backups/pre_alert_engine_{ts} 2>/dev/null || true", check=False)
    print(f"      Snapshot: pre_alert_engine_{ts}")

    # 2. Upload backend files
    print("\n[2/3] Uploading backend files...")
    upload(sftp, BACKEND_FILES)
    sftp.close()

    # 3. Restart (migration 005 runs on startup, engine initialises)
    print(f"\n[3/3] Restarting {SERVICE}...")
    run(ssh, f"sudo systemctl restart {SERVICE}")
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() == "active":
        print("      Service active ✓")
    else:
        print(f"      ERROR: status = '{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 50 --no-pager", check=False)
        ssh.close()
        sys.exit(1)

    # Show alert engine startup lines from log
    print("\n      Recent log (alert engine):")
    run(ssh,
        f"journalctl -u {SERVICE} -n 20 --no-pager | grep -i 'alert\\|migration\\|engine' || true",
        check=False)

    ssh.close()
    print(f"\n[deploy] Done. pktSNMP running at http://{HOST}:8767")
    print("         Alerts page now fires real rules. Dashboard badge is live.")


if __name__ == "__main__":
    main()
