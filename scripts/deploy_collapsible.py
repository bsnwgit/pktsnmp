#!/usr/bin/env python3
"""Deploy collapsible tree — frontend only."""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST, PORT, USER = "172.23.80.5", 22, "ec2-user"
KEY_PATH   = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15)
print("Connected.\n")

def run(cmd, timeout=300, check=True):
    print(f"  $ {cmd[:140]}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out: print(f"    {out}")
    if err and rc != 0: print(f"    STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        client.close(); sys.exit(1)
    return rc, out

print("[1/3] Uploading Dashboard.tsx…")
sftp = client.open_sftp()
sftp.put(
    os.path.join(LOCAL_ROOT, "frontend/src/pages/Dashboard.tsx"),
    f"{REMOTE_APP}/frontend/src/pages/Dashboard.tsx"
)
sftp.close()
print("      Done.\n")

print("[2/3] Building frontend on O2…")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
print("      Build complete.\n")

print("[3/3] Restarting service…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(4)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print("      Service active ✓")
else:
    run("tail -30 /mnt/software/logs/pktsnmp.log", check=False)
    client.close(); sys.exit(1)

client.close()
print(f"\nDone — http://{HOST}:8767")
