# Push fixed client.ts, retry build, deploy dist, install + start service.
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

KEY_PATH    = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
HOST        = "172.23.80.5"
REMOTE_DEST = "/mnt/software/pktsnmp"
NVM         = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
c   = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="ec2-user", pkey=key, timeout=15)
print(f"Connected to {HOST}")

def run(cmd, timeout=300, check=True):
    print(f"  $ {cmd[:100]}")
    _, stdout, _ = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace").strip()
    rc  = stdout.channel.recv_exit_status()
    if out:
        print(out)
    if check and rc != 0:
        print(f"FAILED rc={rc}", file=sys.stderr)
        c.close()
        sys.exit(1)
    return rc

# 1. Push fixed client.ts to /tmp build dir
print("\n=== 1. Push fixed client.ts ===")
sftp = c.open_sftp()
sftp.put(
    r"C:\Users\robert.barnett\My Drive\Documents\Claude\Projects\pktSNMP\frontend\src\api\client.ts",
    "/tmp/pktsnmp-fe/src/api/client.ts"
)
sftp.close()
print("  client.ts updated on O2")

# 2. Retry build
print("\n=== 2. npm run build ===")
rc = run(f"{NVM} && cd /tmp/pktsnmp-fe && npm run build 2>&1 && echo BUILD_OK || echo BUILD_FAILED", check=False)

# 3. Check actual build output for errors
_, o, _ = c.exec_command(f"{NVM} && cd /tmp/pktsnmp-fe && npm run build 2>&1", timeout=300)
out = o.read().decode("utf-8", "replace")
rc2 = o.channel.recv_exit_status()
# Show last portion of output
lines = out.strip().splitlines()
for line in lines[-40:]:
    print(line)
print(f"\n  exit code: {rc2}")

if rc2 != 0:
    print("Build failed — stopping.", file=sys.stderr)
    c.close()
    sys.exit(1)

# 4. Deploy dist
print("\n=== 3. Deploy dist ===")
run(f"rm -rf {REMOTE_DEST}/frontend/dist && cp -r /tmp/pktsnmp-fe/dist {REMOTE_DEST}/frontend/dist && echo 'dist deployed'")

# 5. Install and start service
print("\n=== 4. Install + start pktsnmp service ===")
run(f"sudo cp {REMOTE_DEST}/pktsnmp.service /etc/systemd/system/pktsnmp.service")
run("sudo systemctl daemon-reload")
run("sudo systemctl enable pktsnmp")
run("sudo systemctl restart pktsnmp", timeout=30)
time.sleep(4)
run("systemctl is-active pktsnmp")
run("curl -s http://localhost:8767/api/auth/status || echo no_response", check=False)

c.close()
print("\n=== Done ===")
