-- pktSNMP migration 007: Remote collector SSH config + sync tracking
-- Adds SSH credentials and sync state to collectors table.
-- Adds otelcol_pipeline to devices for pipeline assignment during config push.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ── Collectors: SSH config ────────────────────────────────────────────────────
ALTER TABLE collectors ADD COLUMN ssh_host TEXT;              -- override; falls back to ip
ALTER TABLE collectors ADD COLUMN ssh_port INTEGER DEFAULT 22;
ALTER TABLE collectors ADD COLUMN ssh_user TEXT;
ALTER TABLE collectors ADD COLUMN ssh_auth_type TEXT DEFAULT 'key';  -- 'key' | 'password'
ALTER TABLE collectors ADD COLUMN ssh_key_enc TEXT;           -- Fernet-encrypted PEM text
ALTER TABLE collectors ADD COLUMN ssh_password_enc TEXT;      -- Fernet-encrypted password
ALTER TABLE collectors ADD COLUMN otelcol_config_path TEXT DEFAULT '/mnt/software/otel/config/otelcol-config.yaml';
ALTER TABLE collectors ADD COLUMN otelcol_service TEXT DEFAULT 'otelcol';

-- ── Collectors: Sync state ────────────────────────────────────────────────────
ALTER TABLE collectors ADD COLUMN sync_status TEXT DEFAULT 'unknown';  -- 'synced'|'out_of_sync'|'error'|'unknown'
ALTER TABLE collectors ADD COLUMN last_synced_at TEXT;
ALTER TABLE collectors ADD COLUMN last_sync_error TEXT;

-- ── Devices: otelcol pipeline assignment ─────────────────────────────────────
ALTER TABLE devices ADD COLUMN otelcol_pipeline TEXT;

-- Seed pipeline for existing devices based on name patterns
UPDATE devices SET otelcol_pipeline = 'metrics/switch'   WHERE name LIKE '%SW%';
UPDATE devices SET otelcol_pipeline = 'metrics/firewall' WHERE name LIKE '%FW%' OR name LIKE '%fw%';
-- AWS devices (dental collector)
UPDATE devices SET otelcol_pipeline = 'metrics/snmp'     WHERE otelcol_pipeline IS NULL AND collector_id = 3;

-- Seed SSH config for known collectors (medical and dental)
UPDATE collectors SET
    ssh_user = 'ec2-user',
    ssh_auth_type = 'key',
    otelcol_config_path = '/mnt/software/otel/config/otelcol-config.yaml',
    otelcol_service = 'otelcol'
WHERE id IN (2, 3);
