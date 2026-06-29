#!/usr/bin/env python3
"""
deploy_ha_role.py -- Deploy HA role tagging.

Changes:
  migrations/006_ha_role.sql          -- adds ha_role column, tags QTS FW3/FW4
  app/api/snmp.py                     -- ha_role in SELECT, models, INSERT, UPDATE
  frontend/src/pages/Devices.tsx      -- HA badge + standby status display

Requires frontend rebuild.
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST       = "172.23.80.5"
PORT       = 22
USER       = "ec2-user"
KEY_PATH   = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

BACKEND_FILES = [
    ("migrations/006_ha_role.sql", "migrations/006_ha_role.sql"),
    ("app/api/snmp.py",            "app/api/snmp.py"),
]

FRONTEND_FILES = [
    ("frontend/src/pages/Devices.tsx", "frontend/src/pages/Devices.tsx"),
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

    # 1. Upload backend
    print("[1/4] Uploading backend files...")
    upload(sftp, BACKEND_FILES)

    # 2. Upload frontend source
    print("\n[2/4] Uploading frontend source...")
    upload(sftp, FRONTEND_FILES)
    sftp.close()

    # 3. Restart backend (migration 006 runs, ha_role column added + tags applied)
    print(f"\n[3/4] Restarting backend (migration runs on startup)...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(5)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() != "active":
        print(f"      ERROR: status='{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 40 --no-pager", check=False)
        ssh.close()
        sys.exit(1)
    print("      Backend active ✓")

    # 4. Frontend build on O2
    print(f"\n[4/4] Building frontend on O2...")
    run(ssh,
        f'{NVM} && cd {REMOTE_APP}/frontend && npm run build',
        timeout=120)

    # Final restart to pick up new dist
    print(f"\n      Restarting to serve new frontend...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    status = out.strip()
    print(f"      Service: {status}")
    if status != "active":
        run(ssh, f"journalctl -u {SERVICE} -n 30 --no-pager", check=False)

    ssh.close()
    print(f"\n[deploy] Done. QTS FW3 = HA active, QTS FW4 = HA passive (standby badge).")

if __name__ == "__main__":
    main()
