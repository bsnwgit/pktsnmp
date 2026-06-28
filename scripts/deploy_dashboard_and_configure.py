#!/usr/bin/env python3
"""
deploy_dashboard_and_configure.py

1. Deploys Dashboard.tsx + client.ts HA fixes, rebuilds frontend.
2. Pre-configures both remote collectors with SSH credentials from the
   PEM keys already on this machine — no manual UI steps needed.

Collector config applied:
  id=2  Medical   COLLECTOR-1-IP  your-key.pem
  id=3  Dental    COLLECTOR-2-IP  corporate_infrastructure.pem
"""
import os, sys, time
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST     = "SERVER-IP"
PORT     = 22
USER     = "ssh-user"
KEY_PATH = r"C:\Users\USER\.ssh\your-key.pem"

LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_APP = "/mnt/software/pktsnmp"
SERVICE    = "pktsnmp"
NVM        = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

FRONTEND_FILES = [
    ("frontend/src/pages/Dashboard.tsx", "frontend/src/pages/Dashboard.tsx"),
    ("frontend/src/api/client.ts",        "frontend/src/api/client.ts"),
]

# SSH key files on this Windows machine
COLLECTOR_SSH = [
    {
        "id":             2,
        "name":           "Medical otelcol",
        "ip":             "COLLECTOR-1-IP",
        "ssh_host":       "COLLECTOR-1-IP",
        "ssh_user":       "ssh-user",
        "ssh_auth_type":  "key",
        "key_path":       r"C:\Users\USER\.ssh\your-key.pem",
        "otelcol_config_path": "/mnt/software/otel/config/otelcol-config.yaml",
        "otelcol_service":     "otelcol",
    },
    {
        "id":             3,
        "name":           "Dental otelcol",
        "ip":             "COLLECTOR-2-IP",
        "ssh_host":       "COLLECTOR-2-IP",
        "ssh_user":       "ssh-user",
        "ssh_auth_type":  "key",
        "key_path":       r"C:\Users\USER\.ssh\corporate_infrastructure.pem",
        "otelcol_config_path": "/mnt/software/otel/config/otelcol-config.yaml",
        "otelcol_service":     "otelcol",
    },
]


def run(ssh, cmd, check=True, timeout=120):
    print(f"  $ {cmd[:100]}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc  = stdout.channel.recv_exit_status()
    if out.strip(): print(f"    {out.strip()}")
    if err.strip(): print(f"    STDERR: {err.strip()}", file=sys.stderr)
    if check and rc != 0:
        raise RuntimeError(f"Command failed (rc={rc}): {cmd[:80]}")
    return rc, out, err


def upload(sftp, files):
    for local_rel, remote_rel in files:
        local  = os.path.join(LOCAL_ROOT, local_rel)
        remote = f"{REMOTE_APP}/{remote_rel}"
        print(f"  up {local_rel}")
        sftp.put(local, remote)


def configure_collector(ssh, collector: dict):
    """Encrypt PEM key on O2 using the app's Fernet key and write to SQLite."""
    cid  = collector["id"]
    name = collector["name"]
    print(f"\n  Configuring collector id={cid} ({name})...")

    # Read PEM from Windows filesystem
    key_path = collector["key_path"]
    if not os.path.exists(key_path):
        print(f"  WARN: key not found at {key_path} — skipping", file=sys.stderr)
        return

    with open(key_path, "r") as f:
        pem_text = f.read().strip()

    # Escape PEM for embedding in a Python heredoc: replace \ with \\, ' with \'
    pem_escaped = pem_text.replace("\\", "\\\\").replace("'", "\\'")

    ssh_host      = collector["ssh_host"]
    ssh_user      = collector["ssh_user"]
    auth_type     = collector["ssh_auth_type"]
    config_path   = collector["otelcol_config_path"]
    service_name  = collector["otelcol_service"]

    # Python snippet that runs on O2:
    #   - reads config.yaml to get secret_key
    #   - derives Fernet key the same way app/_encrypt() does
    #   - encrypts the PEM text
    #   - writes to pktsnmp.db
    python_cmd = f"""python3 - <<'PYEOF'
import base64, sys, yaml, sqlite3

# Read app secret key from config.yaml
with open('{REMOTE_APP}/config.yaml') as f:
    cfg = yaml.safe_load(f)

secret = cfg.get('secret_key', '')
fkey   = base64.urlsafe_b64encode(secret.encode()[:32].ljust(32, b'0'))

from cryptography.fernet import Fernet
fn = Fernet(fkey)

pem = '''{pem_escaped}'''
enc = fn.encrypt(pem.encode()).decode()

db = sqlite3.connect('{REMOTE_APP}/pktsnmp.db')
db.execute(
    \"\"\"UPDATE collectors SET
        ssh_host=?, ssh_port=22, ssh_user=?, ssh_auth_type=?,
        ssh_key_enc=?, ssh_password_enc=NULL,
        otelcol_config_path=?, otelcol_service=?,
        updated_at=datetime('now')
       WHERE id=?\"\"\",
    ('{ssh_host}', '{ssh_user}', '{auth_type}',
     enc, '{config_path}', '{service_name}', {cid})
)
db.commit()
db.close()
print('OK collector {cid} configured')
PYEOF"""

    rc, out, err = run(ssh, python_cmd, timeout=30)
    if rc == 0:
        print(f"  ✓ {name} SSH credentials stored")
    else:
        print(f"  ✗ {name} failed: {err}", file=sys.stderr)


def main():
    print(f"[deploy] Connecting to {USER}@{HOST}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
    ssh.connect(HOST, port=PORT, username=USER, pkey=key, timeout=15)
    print("[deploy] Connected.\n")

    sftp = ssh.open_sftp()

    # 1. Upload frontend source
    print("[1/3] Uploading frontend source...")
    upload(sftp, FRONTEND_FILES)
    sftp.close()

    # 2. Pre-configure collectors with SSH credentials
    print("\n[2/3] Configuring collector SSH credentials...")
    for c in COLLECTOR_SSH:
        configure_collector(ssh, c)

    # 3. Frontend build on O2
    print(f"\n[3/3] Building frontend on O2...")
    run(ssh, f'{NVM} && cd {REMOTE_APP}/frontend && npm run build', timeout=180)

    print(f"\n      Restarting to serve new frontend...")
    run(ssh, f"sudo systemctl restart {SERVICE}", timeout=180)
    time.sleep(4)
    rc, out, _ = run(ssh, f"systemctl is-active {SERVICE}", check=False)
    print(f"      Service: {out.strip()}")
    if out.strip() != "active":
        run(ssh, f"journalctl -u {SERVICE} -n 20 --no-pager", check=False)

    ssh.close()
    print("\n[deploy] Done.")
    print("  → Dashboard device grid now shows HA badge + standby label")
    print("  → Medical and dental collectors pre-configured with SSH keys")
    print("  → Go to Collectors UI → Test SSH to verify, then ↑ Sync each one")


if __name__ == "__main__":
    main()
