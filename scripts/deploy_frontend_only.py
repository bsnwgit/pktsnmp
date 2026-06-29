#!/usr/bin/env python3
"""Quick: upload frontend files + build + restart."""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST      = "203.0.113.10"
USER      = "ec2-user"
KEY_PATH  = r"C:\Users\USER\.ssh\your-key.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=key, timeout=15)
print("Connected.")

sftp = client.open_sftp()
files = [
    ("frontend/src/pages/OidCatalog.tsx",  f"{REMOTE_APP}/frontend/src/pages/OidCatalog.tsx"),
    ("frontend/src/pages/Collectors.tsx",  f"{REMOTE_APP}/frontend/src/pages/Collectors.tsx"),
    ("frontend/src/pages/Devices.tsx",     f"{REMOTE_APP}/frontend/src/pages/Devices.tsx"),
    ("frontend/src/pages/Dashboard.tsx",   f"{REMOTE_APP}/frontend/src/pages/Dashboard.tsx"),
]
for local_rel, remote in files:
    sftp.put(os.path.join(LOCAL_ROOT, local_rel), remote)
    print(f"  up {local_rel}")
sftp.close()

def run(cmd, timeout=300):
    print(f"  $ {cmd[:120]}")
    _, o, e = client.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    rc  = o.channel.recv_exit_status()
    if out: print("   ", out[-800:])
    if err and rc != 0: print("   STDERR:", err[-300:])
    return rc

run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build')
run("sudo systemctl restart pktsnmp")
time.sleep(4)
run("systemctl is-active pktsnmp")
client.close()
print("Done.")
