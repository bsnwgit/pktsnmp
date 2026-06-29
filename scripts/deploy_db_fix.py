#!/usr/bin/env python3
import os, sys, time, paramiko
sys.stdout.reconfigure(encoding="utf-8")
KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15)
print("Connected.")
sftp = c.open_sftp()
sftp.put(os.path.join(LOCAL_ROOT, "app/database.py"), f"{REMOTE_APP}/app/database.py")
print("Uploaded database.py")
sftp.close()
def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=30)
    out = o.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
run("sudo systemctl restart pktsnmp")
time.sleep(5)
run("systemctl is-active pktsnmp")
run("journalctl -u pktsnmp -n 5 --no-pager -o cat | grep -v Consumed")
c.close()
print("Done.")
