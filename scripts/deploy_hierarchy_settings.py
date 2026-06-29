#!/usr/bin/env python3
"""
deploy_hierarchy_settings.py

Deploys the Hierarchy Settings feature:
  - migrations/013_hierarchy_tables.sql  (new orgs / groups_def / sites_def tables)
  - app/api/snmp.py                      (hierarchy CRUD endpoints)
  - frontend/src/api/client.ts           (HierarchyOrg/Group/Site types + API methods)
  - frontend/src/pages/Settings.tsx      (Hierarchy tab + HierarchyTab component)
  - frontend/src/pages/Devices.tsx       (cascading Org/Group/Site selects)

ONE run, no retry loops.
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST     = "172.23.80.5"
PORT     = 22
USER     = "ec2-user"
KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"

LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
DB_PATH    = "/mnt/software/pktsnmp/pktsnmp.db"

FILES = [
    ("migrations/013_hierarchy_tables.sql",   "migrations/013_hierarchy_tables.sql"),
    ("app/api/snmp.py",                        "app/api/snmp.py"),
    ("frontend/src/api/client.ts",             "frontend/src/api/client.ts"),
    ("frontend/src/pages/Settings.tsx",        "frontend/src/pages/Settings.tsx"),
    ("frontend/src/pages/Devices.tsx",         "frontend/src/pages/Devices.tsx"),
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
print("[2/4] Running migration 013…")
migration_script = (
    'import sqlite3, sys\n'
    f'conn = sqlite3.connect("{DB_PATH}")\n'
    'conn.execute("PRAGMA foreign_keys=ON")\n'
    'def applied(name):\n'
    '    row = conn.execute("SELECT 1 FROM _migrations WHERE filename=?", (name,)).fetchone()\n'
    '    return row is not None\n'
    'def tables():\n'
    '    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\n'
    'if not applied("013_hierarchy_tables.sql"):\n'
    '    t = tables()\n'
    '    if "orgs" not in t:\n'
    '        conn.execute("CREATE TABLE orgs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))")\n'
    '        print("013: created orgs table")\n'
    '    if "groups_def" not in t:\n'
    '        conn.execute("CREATE TABLE groups_def (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')), UNIQUE(org_id, name))")\n'
    '        print("013: created groups_def table")\n'
    '    if "sites_def" not in t:\n'
    '        conn.execute("CREATE TABLE sites_def (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL REFERENCES groups_def(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')), UNIQUE(group_id, name))")\n'
    '        print("013: created sites_def table")\n'
    '    conn.execute("INSERT OR IGNORE INTO _migrations (filename) VALUES (\'013_hierarchy_tables.sql\')")\n'
    '    conn.commit()\n'
    '    print("013: migration applied")\n'
    'else:\n'
    '    print("013: already applied, skipping")\n'
    'final = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\n'
    'required = {"orgs", "groups_def", "sites_def"}\n'
    'missing = required - final\n'
    'if missing:\n'
    '    print("MISSING tables:", missing)\n'
    '    sys.exit(1)\n'
    'print("Migration OK -- tables:", sorted(final & required))\n'
    'conn.close()\n'
    'sys.exit(0)\n'
)

sftp = client.open_sftp()
with sftp.open('/tmp/migrate_013.py', 'w') as f:
    f.write(migration_script)
sftp.close()
rc, _ = run("python3 /tmp/migrate_013.py", check=False)
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
print("Next: Settings → Hierarchy to define your org tree, then Devices → Add/Edit uses dropdowns.")
