# pktSNMP initial deploy script.
# Run via Desktop Commander start_process (cmd shell).
# Usage: python.exe "...pktSNMP/scripts/deploy_initial.py"
#
# What this does:
#   1. SFTP uploads entire project to /mnt/software/pktsnmp/ on O2
#   2. Creates Python venv, installs requirements
#   3. Initialises SQLite DB, creates admin user
#   4. Builds React frontend in /tmp on O2 (NVM / Linux node)
#   5. Deploys dist + installs/starts systemd service

import paramiko, sys, os, time
sys.stdout.reconfigure(encoding='utf-8')

LOCAL_SRC   = r"C:\Users\robert.barnett\My Drive\Documents\Claude\Projects\pktSNMP"
REMOTE_DEST = "/mnt/software/pktsnmp"
KEY_PATH    = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
HOST        = "172.23.80.5"
USER        = "ec2-user"
SERVICE     = "pktsnmp"
VENV        = f"{REMOTE_DEST}/venv"
NVM         = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

SKIP_DIRS  = {"node_modules", "__pycache__", ".git", "dist", "venv", ".venv",
              ".mypy_cache", ".pytest_cache", "build", ".next"}
SKIP_FILES = {".DS_Store", "Thumbs.db", ".env"}

# ── Connect ────────────────────────────────────────────────────────────────────
print("=== Connecting to O2 ===")
key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=key, timeout=15, banner_timeout=15)
print(f"Connected as {USER}@{HOST}\n")

# ── SSH helper ─────────────────────────────────────────────────────────────────
def run(cmd, timeout=180, check=True):
    print(f"  $ {cmd[:120]}")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    rc  = stdout.channel.recv_exit_status()
    if out:
        print(out)
    if err and rc != 0:
        print(f"  STDERR: {err}", file=sys.stderr)
    if check and rc != 0:
        print(f"\n!! Command failed (rc={rc}): {cmd}", file=sys.stderr)
        client.close()
        sys.exit(1)
    return rc, out

# ── SFTP helpers ───────────────────────────────────────────────────────────────
def sftp_mkdir_p(sftp, remote_dir):
    parts = remote_dir.split('/')
    path  = ''
    for part in parts:
        if not part:
            path = '/'
            continue
        path = path.rstrip('/') + '/' + part
        try:
            sftp.stat(path)
        except FileNotFoundError:
            sftp.mkdir(path)

def upload_dir(sftp, local_dir, remote_dir, depth=0):
    sftp_mkdir_p(sftp, remote_dir)
    for item in sorted(os.listdir(local_dir)):
        if item in SKIP_DIRS or item in SKIP_FILES:
            continue
        local_path  = os.path.join(local_dir, item)
        remote_path = remote_dir.rstrip('/') + '/' + item
        if os.path.isdir(local_path):
            upload_dir(sftp, local_path, remote_path, depth + 1)
        else:
            sftp.put(local_path, remote_path)
            if depth < 2:
                print(f"  → {remote_path}")

# ── 1. Upload project ─────────────────────────────────────────────────────────
print("=== 1/7 Uploading project files to O2 ===")
run(f"mkdir -p {REMOTE_DEST} /mnt/software/pktsnmp_backups /mnt/software/logs", check=False)
sftp = client.open_sftp()
upload_dir(sftp, LOCAL_SRC, REMOTE_DEST)
sftp.close()
print("Upload complete.\n")

# ── 2. Python venv + deps ──────────────────────────────────────────────────────
print("=== 2/7 Python venv + requirements ===")
run(f"python3 -m venv {VENV}")
run(f"{VENV}/bin/pip install --quiet --upgrade pip")
run(f"{VENV}/bin/pip install --quiet -r {REMOTE_DEST}/requirements.txt", timeout=300)
print()

# ── 3. Config file ────────────────────────────────────────────────────────────
print("=== 3/7 Config ===")
run(f"""
if [ ! -f {REMOTE_DEST}/config.yaml ]; then
    cp {REMOTE_DEST}/config.example.yaml {REMOTE_DEST}/config.yaml
    SECRET=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_generate_with_openssl_rand_hex_32/$SECRET/" {REMOTE_DEST}/config.yaml
    echo "  config.yaml created"
else
    echo "  config.yaml already exists — skipping"
fi
""")
print()

# ── 4. Initialise DB + admin user ─────────────────────────────────────────────
print("=== 4/7 DB init + admin user ===")
admin_pass = "ChangeMe123!"   # user should update this in Users settings
run(f"""{VENV}/bin/python3 - << 'PYEOF'
import asyncio, sys, os, json
sys.path.insert(0, '{REMOTE_DEST}')
os.environ['PKTSNMP_CONFIG'] = '{REMOTE_DEST}/config.yaml'

from app.database import init_db
from app.auth.local import hash_password
import aiosqlite
from app.config import get_settings

async def setup():
    await init_db()
    cfg = get_settings()
    async with aiosqlite.connect(cfg.db_path) as db:
        hashed = hash_password('{admin_pass}')
        await db.execute(
            "INSERT OR IGNORE INTO users (username, email, hashed_password, role) VALUES (?,?,?,?)",
            ('admin', 'admin@pktsnmp.local', hashed, 'admin')
        )
        await db.commit()
    print("  DB initialised, admin user created.")

asyncio.run(setup())
PYEOF
""", timeout=60)
print()

# ── 5. Build frontend (in /tmp, same as pktFlow pattern) ──────────────────────
print("=== 5/7 npm install ===")
run(f"rm -rf /tmp/pktsnmp-fe && cp -r {REMOTE_DEST}/frontend /tmp/pktsnmp-fe && echo 'copy ok'")
run(f"{NVM} && cd /tmp/pktsnmp-fe && npm install --silent 2>/dev/null && echo 'install ok'", timeout=240)

print("\n=== 6/7 npm run build ===")
rc, _ = run(
    f"{NVM} && cd /tmp/pktsnmp-fe && npm run build > /dev/null 2>&1 && echo 'build ok' || echo 'BUILD FAILED'",
    timeout=300, check=False
)
if rc != 0:
    print("\nBuild failed — check /tmp/pktsnmp-fe for errors.")
    client.close()
    sys.exit(1)
run(f"rm -rf {REMOTE_DEST}/frontend/dist && cp -r /tmp/pktsnmp-fe/dist {REMOTE_DEST}/frontend/dist && echo 'dist deployed'")
print()

# ── 6. Install + start service ────────────────────────────────────────────────
print("=== 7/7 systemd service ===")
run(f"sudo cp {REMOTE_DEST}/pktsnmp.service /etc/systemd/system/pktsnmp.service")
run("sudo systemctl daemon-reload")
run("sudo systemctl enable pktsnmp")
run("sudo systemctl restart pktsnmp", timeout=30)
time.sleep(4)
run("systemctl is-active pktsnmp")
run("curl -s http://localhost:8767/api/auth/status || echo '(no response yet)'", check=False)

client.close()
print(f"""
╔══════════════════════════════════════════════════════════╗
║           pktSNMP deployed successfully!                 ║
╠══════════════════════════════════════════════════════════╣
║  URL:      http://172.23.80.5:8767                       ║
║  Username: admin                                         ║
║  Password: {admin_pass:<45} ║
║                                                          ║
║  CHANGE THE PASSWORD in Settings → Users after login.   ║
╚══════════════════════════════════════════════════════════╝
""")
