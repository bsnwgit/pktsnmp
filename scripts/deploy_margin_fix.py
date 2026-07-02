#!/usr/bin/env python3
"""Deploy margin fix: remove max-w-*xl mx-auto from OidCatalog, Collectors, Devices."""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST      = "SERVER-IP"
USER      = "ssh-user"
KEY_PATH  = r"PATH\TO\YOUR-KEY.pem"
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=key, timeout=15)
print("Connected.")

sftp = client.open_sftp()
files = [
    ("frontend/src/pages/OidCatalog.tsx",  f"{REMOTE_APP}/frontend/src/pages/OidCatalog.tsx"),
    ("frontend/src/pages/Collectors.tsx",  f"{REMOTE_APP}/frontend/src/pages/Collectors.tsx"),
    ("frontend/src/pages/Devices.tsx",     f"{REMOTE_APP}/frontend/src/pages/Devices.tsx"),
]
for local, remote in files:
    sftp.put(os.path.join(LOCAL_ROOT, local), remote)
    print(f"Uploaded {local}")
sftp.close()

def run(cmd, timeout=300):
    print(f"  $ {cmd[:100]}")
    _, o, e = client.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace").strip()
    err = e.read().decode("utf-8", errors="replace").strip()
    rc  = o.channel.recv_exit_status()
    if out: print("   ", out[-800:])
    if err and rc != 0: print("   STDERR:", err[-300:])
    return rc

run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build')
print("Build done.")
run("sudo systemctl restart pktsnmp")
time.sleep(3)
run("systemctl is-active pktsnmp")
client.close()
print("Done.")
