#!/usr/bin/env python3
"""Deploy alert badge fix: Layout.tsx + client.ts, build frontend, restart."""
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

def run(cmd, timeout=60):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    if out: print(out)
    if err and "warning" not in err.lower(): print("STDERR:", err[:300])
    return out

# Upload changed frontend files
for local, remote in [
    ("frontend/src/components/Layout.tsx", "frontend/src/components/Layout.tsx"),
    ("frontend/src/api/client.ts",         "frontend/src/api/client.ts"),
]:
    sftp.put(os.path.join(LOCAL_ROOT, local), f"{REMOTE_APP}/{remote}")
    print(f"Uploaded {local}")

sftp.close()

# Build on server
print("\n── npm run build ──")
run(
    'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && '
    f'cd {REMOTE_APP}/frontend && npm run build 2>&1 | tail -8',
    timeout=120,
)

# Restart
print("\n── Restarting pktsnmp ──")
run("sudo systemctl restart pktsnmp")
time.sleep(5)
status = run("systemctl is-active pktsnmp")
print("Status:", status)

c.close()
print("Done.")
