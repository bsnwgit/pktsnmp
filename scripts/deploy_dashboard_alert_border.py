#!/usr/bin/env python3
import os, sys, time, paramiko
sys.stdout.reconfigure(encoding="utf-8")
KEY_PATH   = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15)
print("Connected.")
sftp = c.open_sftp()
def run(cmd, timeout=120):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err and 'warning' not in err.lower(): print("ERR:", err[:200])
sftp.put(os.path.join(LOCAL_ROOT, "frontend/src/pages/Dashboard.tsx"), f"{REMOTE_APP}/frontend/src/pages/Dashboard.tsx")
print("Uploaded Dashboard.tsx")
sftp.close()
run('export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd /mnt/software/pktsnmp/frontend && npm run build 2>&1 | tail -5')
run("sudo systemctl restart pktsnmp")
time.sleep(4)
run("systemctl is-active pktsnmp")
c.close()
print("Done.")
