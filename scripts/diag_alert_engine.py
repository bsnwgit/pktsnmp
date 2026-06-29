#!/usr/bin/env python3
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")
key = paramiko.RSAKey.from_private_key_file(r"C:\Users\USER\.ssh\your-key.pem")
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)

def run(cmd):
    _, o, e = c.exec_command(cmd, timeout=20)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    return out + ("\nERR: " + err if err else "")

script = """
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')

print("=== ALERT RULES ===")
rules = conn.execute("SELECT id, name, rule_type, enabled, cooldown_min FROM alert_rules").fetchall()
for r in rules:
    print(f"  id={r[0]}  {r[1]:30s}  type={r[2]}  enabled={r[3]}  cooldown={r[4]}m")

print()
print("=== ALERT EVENTS ===")
events = conn.execute(
    "SELECT id, rule_id, device_id, severity, message, fired_at, resolved_at FROM alert_events ORDER BY fired_at DESC LIMIT 10"
).fetchall()
if not events:
    print("  (no events yet)")
else:
    for e in events:
        resolved = e[6] or "OPEN"
        print(f"  id={e[0]} rule={e[1]} device_id={e[2]} sev={e[3]} fired={e[5]} resolved={resolved}")
        print(f"    msg: {e[4][:80]}")

print()
print("=== DEVICES STATUS ===")
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print("now:", now)
devs = conn.execute(
    "SELECT id, name, status, last_seen, enabled FROM devices ORDER BY last_seen DESC"
).fetchall()
for d in devs:
    print(f"  id={d[0]} {d[1]:28s} {d[2]:6s} last={d[3]}  enabled={d[4]}")

conn.close()
"""

import tempfile, os
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8')
tmp.write(script)
tmp.close()
sftp = c.open_sftp()
sftp.put(tmp.name, '/tmp/ae_check.py')
sftp.close()
os.unlink(tmp.name)

print(run("python3 /tmp/ae_check.py"))

print("\n=== ALERT ENGINE LOG LINES ===")
print(run("grep -i 'alert\\|ALERT\\|engine\\|fired\\|resolved' /mnt/software/logs/pktsnmp.log | tail -15"))

c.close()
