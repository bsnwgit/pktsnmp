#!/usr/bin/env python3
"""
update_collector_dental.py — Redirect dental otelcol SNMP metrics to pktSNMP.

Collector host : 10.56.57.181 (ec2-user, corporate_infrastructure.pem)
pktSNMP host   : 172.23.80.5  (ec2-user, VyneCorpNetInfra.pem)
Collector id   : 3
SNMP pipelines : metrics/firewall

Steps:
  1. Generate a random API token.
  2. SSH to O2 (172.23.80.5) and write the token into pktsnmp.db.
  3. SSH to the collector host.
  4. Backup the otelcol config.
  5. Read, patch, and write the config via SFTP.
  6. Validate the new config with otelcol validate.
     On failure: restore backup, exit(1).
  7. Restart otelcol and confirm it is active.

Requirements:
    pip install paramiko pyyaml

IMPORTANT: ONE SSH connection per host — no retry loops.
"""

import io
import secrets
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import paramiko
import yaml

# ── Config ──────────────────────────────────────────────────────────────────────
O2_HOST         = "172.23.80.5"
O2_USER         = "ec2-user"
O2_KEY_PATH     = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"

COLLECTOR_HOST  = "10.56.57.181"
COLLECTOR_USER  = "ec2-user"
COLLECTOR_KEY_PATH = r"C:\Users\robert.barnett\.ssh\corporate_infrastructure.pem"

SSH_PORT        = 22
DB_PATH         = "/mnt/software/pktsnmp/pktsnmp.db"
COLLECTOR_ID    = 3
CONFIG_PATH     = "/mnt/software/otel/config/otelcol-config.yaml"
BACKUP_PATH     = CONFIG_PATH + ".bak"
PKTSNMP_INGEST  = "http://172.23.80.5:8767/api/snmp/ingest/otlp"
SNMP_PIPELINES  = ["metrics/firewall"]
# ────────────────────────────────────────────────────────────────────────────────


def load_key(path: str) -> paramiko.PKey:
    """Try RSA first, then Ed25519."""
    try:
        return paramiko.RSAKey.from_private_key_file(path)
    except Exception:
        return paramiko.Ed25519Key.from_private_key_file(path)


def run(client: paramiko.SSHClient, command: str, check: bool = True):
    """Execute a command and return (stdout, stderr, exit_code)."""
    stdin, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if check and code != 0:
        raise RuntimeError(
            f"Command failed (exit {code}):\n  cmd : {command}\n  stderr: {err.strip()}"
        )
    return out, err, code


def connect(host: str, user: str, key_path: str) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    key = load_key(key_path)
    client.connect(hostname=host, port=SSH_PORT, username=user, pkey=key)
    return client


def step(msg: str):
    print(f"\n[*] {msg}")


def ok(msg: str):
    print(f"    OK  {msg}")


def main():
    # ── Step 1: Generate token ─────────────────────────────────────────────────
    step("Generating API token")
    token = secrets.token_urlsafe(32)
    ok("Token generated (shown once at end)")

    # ── Step 2: Register token in pktSNMP SQLite on O2 ────────────────────────
    step(f"Connecting to O2 ({O2_HOST}) to register token in pktsnmp.db")
    o2_client = connect(O2_HOST, O2_USER, O2_KEY_PATH)
    try:
        script = (
            f"import sqlite3\n"
            f"conn = sqlite3.connect('{DB_PATH}')\n"
            f"conn.execute(\"UPDATE collectors SET api_token=?, updated_at=datetime('now') WHERE id=?\", ('{token}', {COLLECTOR_ID}))\n"
            f"conn.commit()\n"
            f"conn.close()\n"
            f"print('ok')\n"
        )
        sftp_o2 = o2_client.open_sftp()
        with sftp_o2.open('/tmp/reg_token.py', 'w') as f:
            f.write(script)
        sftp_o2.close()
        out, err, code = run(o2_client, "python3 /tmp/reg_token.py && rm /tmp/reg_token.py")
        ok(f"Token registered for collector id={COLLECTOR_ID}")
    finally:
        o2_client.close()

    # ── Step 3: Connect to collector host ──────────────────────────────────────
    step(f"Connecting to collector host ({COLLECTOR_HOST})")
    col_client = connect(COLLECTOR_HOST, COLLECTOR_USER, COLLECTOR_KEY_PATH)
    backup_done = False

    try:
        # ── Step 4: Backup config ──────────────────────────────────────────────
        step(f"Backing up config: {CONFIG_PATH} → {BACKUP_PATH}")
        run(col_client, f"sudo cp {CONFIG_PATH} {BACKUP_PATH}")
        backup_done = True
        ok("Backup created")

        # ── Step 5: Read config via SFTP ───────────────────────────────────────
        step("Reading otelcol config via SFTP")
        # Copy to /tmp first so ec2-user can read it
        run(col_client, f"sudo cp {CONFIG_PATH} /tmp/otelcol-read.yaml && sudo chmod 644 /tmp/otelcol-read.yaml")
        sftp = col_client.open_sftp()
        try:
            with sftp.open("/tmp/otelcol-read.yaml", "r") as f:
                content = f.read().decode("utf-8")
            ok(f"Read {len(content)} bytes")

            # ── Step 6a: Parse and patch YAML ─────────────────────────────────
            step("Parsing and patching YAML config")
            config = yaml.safe_load(content)

            # Ensure exporters section exists
            if "exporters" not in config:
                config["exporters"] = {}

            # Inject new exporter
            new_exporter = {
                "endpoint": PKTSNMP_INGEST,
                "headers": {"Authorization": f"Bearer {token}"},
                "tls": {"insecure": True},
            }
            config["exporters"]["otlphttp/pktsnmp"] = new_exporter
            ok("Injected exporter 'otlphttp/pktsnmp'")

            # Patch SNMP pipelines
            for pipeline_name in SNMP_PIPELINES:
                pipeline = config.get("service", {}).get("pipelines", {}).get(pipeline_name)
                if pipeline is None:
                    print(f"    WARN pipeline '{pipeline_name}' not found in config — skipping")
                    continue
                exporters = pipeline.get("exporters", [])
                if "otlp/openobserve" in exporters:
                    exporters.remove("otlp/openobserve")
                    print(f"    Removed 'otlp/openobserve' from {pipeline_name}")
                if "otlphttp/pktsnmp" not in exporters:
                    exporters.append("otlphttp/pktsnmp")
                    print(f"    Added  'otlphttp/pktsnmp' to {pipeline_name}")
                pipeline["exporters"] = exporters
            ok("Pipelines patched")

            # ── Step 6b: Write patched config via /tmp then sudo mv ───────────
            step("Writing patched config via SFTP")
            output = yaml.dump(config, default_flow_style=False, allow_unicode=True)
            with sftp.open("/tmp/otelcol-config-new.yaml", "w") as f:
                f.write(output)
            ok(f"Wrote {len(output)} bytes to /tmp")
        finally:
            sftp.close()
        run(col_client, f"sudo mv /tmp/otelcol-config-new.yaml {CONFIG_PATH}")
        ok(f"Config moved to {CONFIG_PATH}")

        # ── Step 7: Validate config ────────────────────────────────────────────
        step("Locating otelcol binary")
        out, _, _ = run(
            col_client,
            "ls /mnt/software/otel/otelcol-contrib 2>/dev/null && echo found || "
            "ls /mnt/software/otel/otelcol 2>/dev/null && echo found || echo notfound",
        )
        if "found" in out:
            out2, _, _ = run(col_client, "ls /mnt/software/otel/otelcol-contrib 2>/dev/null && echo contrib || echo base", False)
            validate_bin = "/mnt/software/otel/otelcol-contrib" if "contrib" in out2 else "/mnt/software/otel/otelcol"
        else:
            validate_bin = None
        ok(f"Using binary: {validate_bin or 'not found — skipping validation'}")

        if validate_bin:
            step("Validating new config")
            out, err, code = run(
                col_client,
                f"{validate_bin} validate --config {CONFIG_PATH}",
                check=False,
            )
            if code != 0:
                print(f"    FAIL Validation failed (exit {code}):")
                print(f"         stdout: {out.strip()}")
                print(f"         stderr: {err.strip()}")
                step("Restoring backup")
                run(col_client, f"sudo cp {BACKUP_PATH} {CONFIG_PATH}")
                ok("Backup restored")
                sys.exit(1)
            ok("Config validated successfully")
        else:
            ok("Skipped validation (binary not found) — will verify via service status")

        # ── Step 8: Restart otelcol ────────────────────────────────────────────
        step("Restarting otelcol service")
        run(col_client, "sudo systemctl restart otelcol")
        ok("Restart command sent")

        step("Waiting 5 seconds for service to stabilise")
        time.sleep(5)

        # ── Step 9: Check status ───────────────────────────────────────────────
        step("Checking otelcol service status")
        out, _, code = run(col_client, "systemctl is-active otelcol", check=False)
        status = out.strip()
        if status == "active":
            ok("otelcol is active")
        else:
            print(f"    WARN otelcol status: {status!r} (may still be starting)")

    except Exception as exc:
        print(f"\n[!] ERROR: {exc}")
        if backup_done:
            print("[!] Attempting to restore backup config")
            try:
                run(col_client, f"sudo cp {BACKUP_PATH} {CONFIG_PATH}")
                print("[!] Backup restored successfully")
            except Exception as restore_exc:
                print(f"[!] CRITICAL: Could not restore backup: {restore_exc}")
        col_client.close()
        sys.exit(1)

    col_client.close()

    print("\n" + "=" * 60)
    print("  Dental collector update COMPLETE")
    print(f"  Host        : {COLLECTOR_HOST}")
    print(f"  Collector ID: {COLLECTOR_ID}")
    print(f"  Pipelines   : {', '.join(SNMP_PIPELINES)}")
    print(f"  Token       : {token}")
    print("  (Store the token securely — it will not be shown again.)")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
