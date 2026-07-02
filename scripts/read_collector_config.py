#!/usr/bin/env python3
"""Read and print the otelcol config from the Collector-1 collector."""

# ── Configuration — update these before running ────────────────────────────
# SERVER_HOST      = "SERVER-IP"       # pktSNMP server IP or hostname
# COLLECTOR_1_HOST = "COLLECTOR-1-IP"  # Remote otelcol collector 1
# SSH_USER         = "ssh-user"        # SSH username on the server
# SSH_KEY_PATH     = r"PATH\TO\YOUR-KEY.pem"  # SSH private key
# ──────────────────────────────────────────────────────────────────────────

import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")

HOST     = "COLLECTOR-1-IP"
USER     = "ssh-user"
KEY_PATH = r"PATH\TO\YOUR-KEY.pem"
CONFIG   = "/mnt/software/otel/config/otelcol-config.yaml"

key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, pkey=key, timeout=15)

sftp = ssh.open_sftp()
with sftp.open(CONFIG, "r") as f:
    print(f.read().decode("utf-8"))
sftp.close()
ssh.close()
