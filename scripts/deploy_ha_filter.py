#!/usr/bin/env python3
"""Deploy HA tree filter — backend only, no frontend rebuild."""
import sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST, PORT, USER = "172.23.80.5", 22, "ec2-user"
KEY_PATH   = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"

import os
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15)
print("Connected.\n")

def run(cmd, timeout=30, check=True):
    print(f"  $ {cmd}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out: print(f"    {out}")
    if err and rc != 0: print(f"    STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        client.close(); sys.exit(1)
    return rc, out

print("[1/2] Uploading snmp.py…")
sftp = client.open_sftp()
sftp.put(os.path.join(LOCAL_ROOT, "app/api/snmp.py"), f"{REMOTE_APP}/app/api/snmp.py")
sftp.close()
print("      Done.\n")

print("[2/2] Restarting service…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(4)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print("      Service active ✓")
else:
    run("tail -30 /mnt/software/logs/pktsnmp.log", check=False)
    client.close(); sys.exit(1)

client.close()
print(f"\nDone — passive/standby devices hidden from dashboard tree.")
