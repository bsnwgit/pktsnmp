#!/usr/bin/env python3
"""Check DuckDB health, storage backend setting, and device last_seen staleness."""
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH = r"C:\Users\USER\.ssh\your-key.pem"
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)

def run(cmd, label=None):
    if label: print(f"\n=== {label} ===")
    _, o, e = c.exec_command(cmd, timeout=30)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("ERR:", err)

run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
row = conn.execute(\"SELECT value FROM settings WHERE key='storage_backend'\").fetchone()
print('storage_backend:', row[0] if row else 'NOT SET (default: duckdb)')
" """, "STORAGE BACKEND SETTING")

run("""python3 -c "
import sqlite3, datetime
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
now = conn.execute(\"SELECT datetime('now')\").fetchone()[0]
print('DB server time:', now)
rows = conn.execute('SELECT id, name, status, last_seen FROM devices ORDER BY last_seen DESC').fetchall()
for r in rows:
    print(f'  {r[\"name\"]:25s} status={r[\"status\"]:8s} last_seen={r[\"last_seen\"]}')
" """, "DEVICE LAST_SEEN (freshest first)")

run("""python3 -c "
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
conn.row_factory = sqlite3.Row
rows = conn.execute('SELECT id, name, status, last_seen FROM collectors ORDER BY id').fetchall()
for r in rows:
    print(dict(r))
" """, "COLLECTOR LAST_SEEN")

# Try to open DuckDB and query it
run("""python3 << 'EOF'
import sys
sys.path.insert(0, '/mnt/software/pktsnmp')
import os; os.chdir('/mnt/software/pktsnmp')
try:
    from app.storage.duckdb import DuckDBStorage
    s = DuckDBStorage()
    import asyncio
    async def test():
        r = await s.get_device_latest(1)
        print('DuckDB query OK, rows:', len(r))
        if r: print('Latest entry:', r[0])
    asyncio.run(test())
except Exception as e:
    print('DuckDB ERROR:', e)
EOF""", "DUCKDB HEALTH CHECK")

# Check last 10 lines of log for recent ingest activity
run("grep -E 'ingest|accepted|ERROR|FATAL' /mnt/software/logs/pktsnmp.log | tail -20", "RECENT INGEST LOG")

c.close()
