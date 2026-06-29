#!/usr/bin/env python3
"""Deploy alert engine fix: status='down' written when device fires, 'up' on resolve."""
import os, sys, time, paramiko
sys.stdout.reconfigure(encoding="utf-8")

KEY_PATH   = r"C:\Users\USER\.ssh\your-key.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("203.0.113.10", username="ec2-user", pkey=key, timeout=15)
print("Connected.")
sftp = c.open_sftp()

def run(cmd, timeout=30):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err: print("ERR:", err[:200])
    return out

sftp.put(
    os.path.join(LOCAL_ROOT, "app", "alerts", "engine.py"),
    f"{REMOTE_APP}/app/alerts/engine.py",
)
print("Uploaded app/alerts/engine.py")
sftp.close()

# Restart — engine re-evaluates within 15s of startup
run("sudo systemctl restart pktsnmp")
time.sleep(8)
run("systemctl is-active pktsnmp")

# Wait for first engine evaluation (15s stagger + a few seconds)
print("Waiting 25s for engine to evaluate...")
time.sleep(25)

# Check SiteA SW1 status
import tempfile, os as _os
script = """
import sqlite3
conn = sqlite3.connect('/mnt/software/pktsnmp/pktsnmp.db')
now = conn.execute("SELECT datetime('now')").fetchone()[0]
print("now:", now)
devs = conn.execute("SELECT id, name, status, last_seen FROM devices ORDER BY id").fetchall()
for d in devs:
    print(f"  id={d[0]}  {d[1]:28s}  status={d[2]:6s}  last_seen={d[3]}")
events = conn.execute(
    "SELECT id, device_id, severity, fired_at, resolved_at FROM alert_events ORDER BY fired_at DESC LIMIT 5"
).fetchall()
print()
print("Recent alert events:")
for e in events:
    print(f"  id={e[0]} dev={e[1]} sev={e[2]} fired={e[3]} resolved={e[4] or 'OPEN'}")
conn.close()
"""
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8')
tmp.write(script)
tmp.close()
sftp2 = c.open_sftp()
sftp2.put(tmp.name, '/tmp/check_status.py')
sftp2.close()
_os.unlink(tmp.name)
print()
run("python3 /tmp/check_status.py")

c.close()
print("Done.")
