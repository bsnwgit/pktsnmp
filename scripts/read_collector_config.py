#!/usr/bin/env python3
"""Read and print the otelcol config from the medical collector."""
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8")

HOST     = "172.23.80.11"
USER     = "ec2-user"
KEY_PATH = r"C:\Users\robert.barnett\.ssh\VyneCorpNetInfra.pem"
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
