#!/usr/bin/env python3
"""Quick deploy: Layout.tsx nav reorder + frontend rebuild."""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST     = "203.0.113.10"
USER     = "ec2-user"
KEY_PATH = r"C:\Users\USER\.ssh\your-key.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=key, timeout=15)
print("Connected.")

sftp = client.open_sftp()
sftp.put(
    os.path.join(LOCAL_ROOT, "frontend/src/components/Layout.tsx"),
    f"{REMOTE_APP}/frontend/src/components/Layout.tsx",
)
sftp.close()
print("Uploaded Layout.tsx")

def run(cmd, timeout=300):
    print(f"  $ {cmd[:120]}")
    _, o, e = client.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    rc  = o.channel.recv_exit_status()
    if out: print("   ", out[-600:])
    if err and rc != 0: print("   STDERR:", err[-200:], file=sys.stderr)
    return rc

run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build')
print("Build done.")
run("sudo systemctl restart pktsnmp")
time.sleep(3)
run("systemctl is-active pktsnmp")
client.close()
print("Done.")
