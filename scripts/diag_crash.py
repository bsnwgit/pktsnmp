#!/usr/bin/env python3
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15)
def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=30)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("ERR:", err)
# Get full stderr from journalctl
run("journalctl -u pktsnmp -n 60 --no-pager -o cat 2>&1 | tail -60")
print("\n--- APP LOG TAIL ---")
run("tail -30 /mnt/software/logs/pktsnmp.log 2>/dev/null || echo 'no log file'")
c.close()
