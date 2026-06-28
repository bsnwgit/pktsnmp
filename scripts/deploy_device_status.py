#!/usr/bin/env python3
"""
deploy_device_status.py -- Patch ingest handler to update device status on otelcol push.

Changed file:
  app/api/snmp.py  -- adds device status='up' + last_seen update in _do_ingest_otlp

No migration. No frontend change.
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST       = "SERVER-IP"
PORT       = 22
USER       = "ssh-user"
KEY_PATH   = r"C:\Users\USER\.ssh\your-key.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"

def run(ssh, cmd, check=True, timeout=120):
    print(f"  $ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    rc  = stdout.channel.recv_exit_status()
    if out.strip(): print(f"    {out.strip()}")
    if err.strip(): print(f"    STDERR: {err.strip()}", file=sys.stderr)
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {cmd}")
    return rc, out, err

def main():
    print(f"[deploy] Connecting to {USER}@{HOST}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
    ssh.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15)
    print("[deploy] Connected.\n")

    sftp = ssh.open_sftp()

    print("[1/3] Uploading app/api/snmp.py...")
    sftp.put(
        os.path.join(LOCAL_ROOT, "app", "api", "snmp.py"),
        f"{REMOTE_APP}/app/api/snmp.py",
    )
    sftp.close()

    print("\n[2/3] Restarting service...")
    run(ssh, f"sudo systemctl restart {SERVICE}")
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    if out.strip() == "active":
        print("      Service active ✓")
    else:
        print(f"      ERROR: status='{out.strip()}'", file=sys.stderr)
        run(ssh, f"journalctl -u {SERVICE} -n 40 --no-pager", check=False)
        ssh.close()
        sys.exit(1)

    print("\n[3/3] Verifying ingest route registered...")
    run(ssh, "curl -s http://localhost:8767/api/health", check=False)

    ssh.close()
    print(f"\n[deploy] Done. Devices will show 'up' on next otelcol push to http://{HOST}:8767/api/snmp/ingest/otlp")

if __name__ == "__main__":
    main()
