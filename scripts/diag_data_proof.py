#!/usr/bin/env python3

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"PATH\TO\YOUR-KEY.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("SERVER-IP", username="ssh-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    return o.read().decode("utf-8", errors="replace").strip()

script = r"""
import sqlite3

conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
ts   = sqlite3.connect('/mnt/software/pktsnmp/snmp_timeseries.db')

now = conn.execute("SELECT datetime('now')").fetchone()[0]
print("Server time:", now)

cnt = ts.execute("SELECT COUNT(*) FROM snmp_poll_results").fetchone()[0]
print(f"Total rows in snmp_poll_results: {cnt:,}")

oldest = ts.execute("SELECT MIN(polled_at) FROM snmp_poll_results").fetchone()[0]
newest = ts.execute("SELECT MAX(polled_at) FROM snmp_poll_results").fetchone()[0]
print(f"Oldest row: {oldest}")
print(f"Newest row: {newest}")

recent = ts.execute("SELECT COUNT(*) FROM snmp_poll_results WHERE polled_at >= datetime('now', '-60 seconds')").fetchone()[0]
print(f"Rows added in last 60s: {recent}")

print()
print("Devices reporting data:")
rows = ts.execute("SELECT device_ip, COUNT(*) as cnt, MAX(polled_at) as latest FROM snmp_poll_results GROUP BY device_ip ORDER BY latest DESC").fetchall()
for r in rows:
    print(f"  {str(r[0])[:35]:35s}  {r[1]:6,} rows  latest={r[2]}")

print()
print("10 most recent data points:")
rows = ts.execute("SELECT polled_at, device_ip, oid_label, value FROM snmp_poll_results ORDER BY polled_at DESC LIMIT 10").fetchall()
for r in rows:
    print(f"  {r[0]}  {str(r[1])[:20]:20s}  {str(r[2])[:22]:22s}  {r[3]}")

print()
print("OID labels:")
oids = ts.execute("SELECT DISTINCT oid_label FROM snmp_poll_results ORDER BY oid_label").fetchall()
for o in oids:
    print(f"  {o[0]}")

conn.close()
ts.close()
"""

_, o, e = c.exec_command(f'python3 -c "{script}"', timeout=20)
out = o.read().decode("utf-8", errors="replace").strip()
err = e.read().decode("utf-8", errors="replace").strip()

# Use a file instead to avoid quoting hell
sftp = c.open_sftp()
import tempfile, os
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False)
tmp.write(script)
tmp.close()
sftp.put(tmp.name, '/tmp/pktsnmp_check.py')
sftp.close()
os.unlink(tmp.name)

_, o, e = c.exec_command('python3 /tmp/pktsnmp_check.py', timeout=20)
print(o.read().decode("utf-8", errors="replace").strip())
err2 = e.read().decode("utf-8", errors="replace").strip()
if err2:
    print("ERR:", err2)

c.close()
