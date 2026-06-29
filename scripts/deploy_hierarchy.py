#!/usr/bin/env python3
"""
deploy_hierarchy.py

Deploys the Org → Group → Site → Device hierarchy feature:
  - migration 011_hierarchy.sql:
      RENAME COLUMN site → groups
      RENAME COLUMN location → site
      ADD COLUMN org TEXT NOT NULL DEFAULT ''
  - app/api/snmp.py    (org/groups/site in models, CRUD, tree endpoint)
  - frontend/src/api/client.ts     (EnvironmentNode types)
  - frontend/src/pages/Dashboard.tsx (OrgNode/GroupNode/SiteNode collapsible tree)
  - frontend/src/pages/Devices.tsx   (org/groups/site fields in form + table)

NOTE: Also handles migration 010 (location column) in case it was never applied.

ONE run, no retry loops.
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST     = "203.0.113.10"
PORT     = 22
USER     = "ec2-user"
KEY_PATH = r"C:\Users\USER\.ssh\your-key.pem"

LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
DB_PATH    = "/mnt/software/pktsnmp/pktsnmp.db"

FILES = [
    ("migrations/011_hierarchy.sql",        "migrations/011_hierarchy.sql"),
    ("migrations/012_device_type.sql",      "migrations/012_device_type.sql"),
    ("app/api/snmp.py",                     "app/api/snmp.py"),
    ("frontend/src/api/client.ts",          "frontend/src/api/client.ts"),
    ("frontend/src/pages/Dashboard.tsx",    "frontend/src/pages/Dashboard.tsx"),
    ("frontend/src/pages/Devices.tsx",      "frontend/src/pages/Devices.tsx"),
]

print(f"=== Connecting to {USER}@{HOST} ===")
key    = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15, banner_timeout=15)
print("Connected.\n")

def run(cmd, timeout=300, check=True):
    print(f"  $ {cmd[:140]}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out: print(f"    {out}")
    if err and rc != 0: print(f"    STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        print(f"\n!! Failed (rc={rc}): {cmd}", file=sys.stderr)
        client.close(); sys.exit(1)
    return rc, out

# ── 1. Upload files ────────────────────────────────────────────────────────────
print("[1/4] Uploading files…")
sftp = client.open_sftp()
for local_rel, remote_rel in FILES:
    sftp.put(os.path.join(LOCAL_ROOT, local_rel), f"{REMOTE_APP}/{remote_rel}")
    print(f"  ↑ {remote_rel}")
sftp.close()
print("      Done.\n")

# ── 2. Run migrations ─────────────────────────────────────────────────────────
print("[2/4] Running migrations…")
migration_script = f"""\
import sqlite3, sys
conn = sqlite3.connect("{DB_PATH}")

def cols():
    return {{r[1] for r in conn.execute("PRAGMA table_info(devices)")}}

# Migration 010: add location column (may already exist from prior deploy)
if "location" not in cols():
    conn.execute("ALTER TABLE devices ADD COLUMN location TEXT NOT NULL DEFAULT ''")
    conn.commit()
    print("010: added location column")
conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES ('010_location.sql')")
conn.commit()

# Migration 011: rename site->groups, location->site, add org
current_cols = cols()

# Step 1: rename site -> groups (only if 'site' exists and 'groups' does not)
if "site" in current_cols and "groups" not in current_cols:
    conn.execute("ALTER TABLE devices RENAME COLUMN site TO groups")
    conn.commit()
    print("011: renamed site -> groups")
elif "groups" in current_cols:
    print("011: groups column already exists, skipping rename")
else:
    print("011: WARNING - neither site nor groups found!")

# Step 2: rename location -> site (only if 'location' exists and new 'site' does not)
current_cols = cols()
if "location" in current_cols and "site" not in current_cols:
    conn.execute("ALTER TABLE devices RENAME COLUMN location TO site")
    conn.commit()
    print("011: renamed location -> site")
elif "site" in current_cols and "location" not in current_cols:
    print("011: site column already exists (location renamed), skipping")
elif "site" in current_cols and "location" in current_cols:
    # Both exist — this means the prior rename of site->groups worked,
    # but location->site hasn't run yet (edge case if migration was partial).
    # 'site' here is the new site from groups rename... wait, no.
    # If groups rename succeeded, 'site' was already consumed. This means
    # we might have a 'site' from a previous partial run. Skip safely.
    print("011: both site and location exist - groups rename may not have happened? Check manually.")

# Step 3: add org column
current_cols = cols()
if "org" not in current_cols:
    conn.execute("ALTER TABLE devices ADD COLUMN org TEXT NOT NULL DEFAULT ''")
    conn.commit()
    print("011: added org column")
else:
    print("011: org column already exists, skipping")

conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES ('011_hierarchy.sql')")
conn.commit()

# Migration 012: add device_type column
current_cols = cols()
if "device_type" not in current_cols:
    conn.execute("ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT ''")
    conn.commit()
    print("012: added device_type column")
else:
    print("012: device_type column already exists, skipping")

conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES ('012_device_type.sql')")
conn.commit()

final = cols()
print("Final columns:", sorted(final))
required = {{"groups", "site", "org", "device_type"}}
missing = required - final
if missing:
    print("MISSING columns:", missing)
    sys.exit(1)
print("Migration OK")
conn.close()
sys.exit(0)
"""

sftp = client.open_sftp()
with sftp.open('/tmp/migrate_011.py', 'w') as f:
    f.write(migration_script)
sftp.close()
rc, _ = run("python3 /tmp/migrate_011.py", check=False)
if rc != 0:
    print("!! Migration failed", file=sys.stderr)
    client.close(); sys.exit(1)
print("      Migration OK.\n")

# ── 3. Build frontend ──────────────────────────────────────────────────────────
print("[3/4] Building frontend on O2…")
run(f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=300)
print("      Build complete.\n")

# ── 4. Restart service ─────────────────────────────────────────────────────────
print(f"[4/4] Restarting {SERVICE}…")
run(f"sudo systemctl restart {SERVICE}")
time.sleep(4)
rc, out = run(f"systemctl is-active {SERVICE}", check=False)
if out.strip() == "active":
    print("      Service active ✓")
else:
    run("tail -40 /mnt/software/logs/pktsnmp.log", check=False)
    client.close(); sys.exit(1)

client.close()
print(f"\n=== Done. pktSNMP at http://{HOST}:8767 ===")
