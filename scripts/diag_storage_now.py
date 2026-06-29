#!/usr/bin/env python3
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("172.23.80.5", username="ec2-user", pkey=key, timeout=15)
def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    return o.read().decode("utf-8", errors="replace").strip()

# What does the settings table say?
print(run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
row = conn.execute(\"SELECT value FROM settings WHERE key='storage_backend'\").fetchone()
print('storage_backend setting:', row[0] if row else 'NOT SET')
" """))

# What does the factory actually instantiate?
print(run("grep -n 'storage_backend\\|DuckDB\\|SQLite\\|duckdb\\|sqlite' /mnt/software/pktsnmp/app/storage/factory.py"))

# Are devices actually in the DB right now?
print(run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
rows = conn.execute('SELECT name, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
print('Device count:', len(rows))
for r in rows: print(f'  {r[0][:28]:28s}  {r[1]:8s}  {r[2]}')
" """))

# Is service currently up?
print("Service:", run("systemctl is-active pktsnmp"))
c.close()
