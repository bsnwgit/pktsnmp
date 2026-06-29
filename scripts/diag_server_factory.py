#!/usr/bin/env python3
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\USER\.ssh\your-key.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    return o.read().decode("utf-8", errors="replace").strip()

print("=== SERVER factory.py (first 60 lines) ===")
print(run("head -60 /mnt/software/pktsnmp/app/storage/factory.py"))

print("\n=== settings table: storage_backend ===")
print(run("""python3 << 'EOF'
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
row = conn.execute("SELECT value FROM settings WHERE key='storage_backend'").fetchone()
print('storage_backend:', row[0] if row else 'NOT SET')
EOF
"""))

print("\n=== Recent ingest errors (last 5 duckdb hits) ===")
print(run("grep duckdb /mnt/software/logs/pktsnmp.log | tail -5"))

c.close()
