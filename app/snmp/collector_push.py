"""
collector_push.py — SSH push of otelcol config to remote collectors.

Admin-only. Called from app/api/snmp.py on POST /collectors/{id}/sync.

Flow:
  1. Load collector SSH config + all enabled devices for that collector.
  2. Decrypt credentials (SNMP auth/priv keys, SSH key/password).
  3. SSH connect via Paramiko (key or password auth).
  4. SFTP-read existing otelcol config YAML.
  5. Patch via otelcol_config.patch_config() — replaces snmp/* receivers,
     updates pipeline receiver lists.
  6. SFTP-write patched YAML back.
  7. sudo systemctl restart <otelcol_service>.
  8. Return result dict; caller updates sync_status in DB.
"""
from __future__ import annotations

import io
import logging

import paramiko
import yaml

log = logging.getLogger("pktsnmp.snmp.collector_push")


# ── SSH helpers ───────────────────────────────────────────────────────────────

def _open_ssh(collector: dict, ssh_key_pem: str | None, ssh_password: str | None) -> paramiko.SSHClient:
    """Open an SSH connection based on collector config. Returns connected client."""
    host = collector.get("ssh_host") or collector.get("ip") or ""
    port = int(collector.get("ssh_port") or 22)
    user = collector.get("ssh_user") or "ec2-user"
    auth_type = (collector.get("ssh_auth_type") or "key").lower()

    if not host:
        raise ValueError("Collector has no host/IP configured for SSH")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    if auth_type == "key":
        if not ssh_key_pem:
            raise ValueError("SSH auth_type=key but no key is stored for this collector")
        try:
            pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_key_pem))
        except paramiko.ssh_exception.SSHException:
            try:
                pkey = paramiko.Ed25519Key.from_private_key(io.StringIO(ssh_key_pem))
            except Exception:
                pkey = paramiko.ECDSAKey.from_private_key(io.StringIO(ssh_key_pem))
        client.connect(host, port=port, username=user, pkey=pkey, timeout=15)
    else:
        if not ssh_password:
            raise ValueError("SSH auth_type=password but no password is stored")
        client.connect(host, port=port, username=user, password=ssh_password, timeout=15)

    return client


def _run(ssh: paramiko.SSHClient, cmd: str, timeout: int = 30) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    rc  = stdout.channel.recv_exit_status()
    return rc, out, err


# ── Credential decryption helper ──────────────────────────────────────────────

def _decrypt_cred(fernet, cred: dict) -> dict:
    """Return credential dict with auth_key / priv_key decrypted (plain text)."""
    c = dict(cred)
    if c.get("auth_key_enc"):
        try:
            c["auth_key"] = fernet.decrypt(c["auth_key_enc"].encode()).decode()
        except Exception:
            c["auth_key"] = ""
    else:
        c["auth_key"] = ""
    if c.get("priv_key_enc"):
        try:
            c["priv_key"] = fernet.decrypt(c["priv_key_enc"].encode()).decode()
        except Exception:
            c["priv_key"] = ""
    else:
        c["priv_key"] = ""
    return c


# ── Public: test SSH connection ───────────────────────────────────────────────

def test_ssh(collector: dict, ssh_key_pem: str | None, ssh_password: str | None) -> dict:
    """
    Verify SSH reachability. Returns {"ok": bool, "message": str}.
    Does not modify anything on the remote.
    """
    try:
        ssh = _open_ssh(collector, ssh_key_pem, ssh_password)
        rc, out, _ = _run(ssh, "echo pktsnmp-ok", timeout=10)
        ssh.close()
        if rc == 0 and "pktsnmp-ok" in out:
            return {"ok": True, "message": "SSH connection successful"}
        return {"ok": False, "message": f"Unexpected response (rc={rc}): {out}"}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


# ── Public: preview generated YAML ───────────────────────────────────────────

def preview_config(collector: dict, devices_with_creds: list[dict],
                   ssh_key_pem: str | None, ssh_password: str | None) -> str:
    """
    SSH-read the current otelcol config, patch it, and return the patched
    YAML string (does not write anything to the remote).
    """
    from app.snmp.otelcol_config import patch_config, config_to_yaml

    ssh = _open_ssh(collector, ssh_key_pem, ssh_password)
    try:
        config_path = collector.get("otelcol_config_path") or "/mnt/software/otel/config/otelcol-config.yaml"
        sftp = ssh.open_sftp()
        with sftp.open(config_path, "r") as f:
            raw = f.read()
        sftp.close()
    finally:
        ssh.close()

    existing = yaml.safe_load(raw) or {}
    patched  = patch_config(existing, devices_with_creds)
    return config_to_yaml(patched)


# ── Public: push config ───────────────────────────────────────────────────────

def push_config(
    collector: dict,
    devices_with_creds: list[dict],
    ssh_key_pem: str | None,
    ssh_password: str | None,
) -> dict:
    """
    Push updated SNMP device config to the remote otelcol collector.

    Returns {"ok": bool, "message": str, "devices_pushed": int}.
    Caller is responsible for updating sync_status / last_synced_at in DB.
    """
    from app.snmp.otelcol_config import patch_config, config_to_yaml

    config_path   = collector.get("otelcol_config_path") or "/mnt/software/otel/config/otelcol-config.yaml"
    service_name  = collector.get("otelcol_service") or "otelcol"
    backup_path   = config_path + ".pktsnmp_bak"

    try:
        ssh = _open_ssh(collector, ssh_key_pem, ssh_password)
    except Exception as exc:
        return {"ok": False, "message": f"SSH connect failed: {exc}", "devices_pushed": 0}

    try:
        sftp = ssh.open_sftp()

        # 1. Read existing config
        try:
            with sftp.open(config_path, "r") as f:
                raw = f.read()
            existing = yaml.safe_load(raw) or {}
        except Exception as exc:
            ssh.close()
            return {"ok": False, "message": f"Cannot read remote config ({config_path}): {exc}", "devices_pushed": 0}

        # 2. Patch
        try:
            patched     = patch_config(existing, devices_with_creds)
            patched_yaml = config_to_yaml(patched)
        except Exception as exc:
            ssh.close()
            return {"ok": False, "message": f"Config generation failed: {exc}", "devices_pushed": 0}

        # 3. Backup existing config
        try:
            _run(ssh, f"cp {config_path} {backup_path}")
        except Exception:
            pass  # backup failure is non-fatal

        # 4. Write patched config
        try:
            with sftp.open(config_path, "w") as f:
                f.write(patched_yaml.encode())
        except Exception as exc:
            # Try to restore backup
            _run(ssh, f"cp {backup_path} {config_path}", timeout=10)
            ssh.close()
            return {"ok": False, "message": f"Cannot write remote config: {exc}", "devices_pushed": 0}

        sftp.close()

        # 5. Restart otelcol service
        rc, out, err = _run(ssh, f"sudo systemctl restart {service_name}", timeout=60)
        if rc != 0:
            # Attempt to restore backup if restart fails
            sftp2 = ssh.open_sftp()
            _run(ssh, f"cp {backup_path} {config_path}", timeout=10)
            _run(ssh, f"sudo systemctl restart {service_name}", timeout=60)
            sftp2.close()
            ssh.close()
            return {
                "ok": False,
                "message": f"Service restart failed (rc={rc}): {err or out}. Original config restored.",
                "devices_pushed": 0,
            }

        # 6. Verify service is active
        rc2, active, _ = _run(ssh, f"systemctl is-active {service_name}", timeout=10)
        if active.strip() != "active":
            ssh.close()
            return {
                "ok": False,
                "message": f"Service {service_name} is not active after restart (state={active}). Check logs.",
                "devices_pushed": len(devices_with_creds),
            }

        ssh.close()
        n = len(devices_with_creds)
        return {
            "ok": True,
            "message": f"Config pushed and {service_name} restarted. {n} device(s) configured.",
            "devices_pushed": n,
        }

    except Exception as exc:
        try:
            ssh.close()
        except Exception:
            pass
        log.exception("Unexpected error during config push")
        return {"ok": False, "message": f"Push failed: {exc}", "devices_pushed": 0}
