#!/usr/bin/env python3
"""Check whether SNMP poll data is actively being written to the DB right now.
Takes two snapshots 65 seconds apart (one full poll cycle) and compares last_seen."""
import paramiko, sys, time
sys.stdout.reconfigure(encoding="utf-8")

key = paramiko.RSAKey.from_private_key_file(r"C:\Users\USER\.ssh\your-key.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=30)
    return o.read().decode("utf-8", errors="replace").strip()

QUERY = """python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute(\"SELECT datetime('now')\").fetchone()[0]
print('server time:', now)
rows = conn.execute('SELECT name, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
for r in rows:
    print(f'  {r[0][:28]:28s}  {r[1]:8s}  {r[2]}')
" """

print("=== SERVER + SNAPSHOT 1 ===")
print(run(QUERY))

print("\nwaiting 65s for one poll cycle...\n")
time.sleep(65)

print("=== SNAPSHOT 2 ===")
print(run(QUERY))

print("\n=== RECENT POLL ENGINE LOG ===")
print(run("grep -iE 'poll|up|down|status' /mnt/software/logs/pktsnmp.log | tail -15"))

print("\n=== INGEST ENDPOINT HITS (last 10) ===")
print(run("grep -i ingest /mnt/software/logs/pktsnmp.log | tail -10"))

c.close()
