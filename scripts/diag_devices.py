#!/usr/bin/env python3
"""Quick diagnostic: device status, poll settings, recent logs."""
import paramiko

HOST     = "172.23.80.5"
USER     = "ec2-user"
KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
DB       = "/mnt/software/pktsnmp/pktsnmp.db"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
ssh.connect(HOST, username=USER, pkey=key, timeout=15)

def run(label, cmd):
    print(f"\n=== {label} ===")
    _, o, e = ssh.exec_command(cmd)
    out = o.read().decode().strip()
    err = e.read().decode().strip()
    if out:
        print(out)
    if err:
        print(f"ERR: {err}")

run("SERVICE STATUS", "systemctl is-active pktsnmp")

run("STARTUP LOGS (since restart)",
    "journalctl -u pktsnmp --since '2 minutes ago' --no-pager")

run("DEVICES TABLE", f"""python3 -c "
import sqlite3, json
db = sqlite3.connect('{DB}')
rows = db.execute('SELECT id, ip, name, status, enabled, collector_id, last_seen, last_error FROM devices').fetchall()
if not rows:
    print('NO DEVICES IN TABLE')
for r in rows:
    print(r)
db.close()
" """)

run("SNMP SETTINGS", f"""python3 -c "
import sqlite3, json
db = sqlite3.connect('{DB}')
rows = db.execute(\"SELECT key, value FROM settings WHERE key LIKE 'snmp_%'\").fetchall()
for k, v in rows:
    print(f'  {{k}} = {{v}}')
db.close()
" """)

ssh.close()
