-- Phase 3: SNMP credential library
-- Devices reference a named credential instead of storing inline creds.

CREATE TABLE IF NOT EXISTS snmp_credentials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL DEFAULT '',
    snmp_version TEXT   NOT NULL DEFAULT 'v2c',
    community   TEXT    NOT NULL DEFAULT 'public',
    security_name  TEXT NOT NULL DEFAULT '',
    security_level TEXT NOT NULL DEFAULT 'noAuthNoPriv',
    auth_protocol  TEXT NOT NULL DEFAULT 'SHA256',
    auth_key_enc   TEXT,
    priv_protocol  TEXT NOT NULL DEFAULT 'AES128',
    priv_key_enc   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snmp_credentials_name ON snmp_credentials (name);

-- Add credential FK to devices (nullable; NULL = device still uses its inline fields)
ALTER TABLE devices ADD COLUMN credential_id INTEGER REFERENCES snmp_credentials(id) ON DELETE SET NULL;

-- Seed a default v2c-public credential
INSERT OR IGNORE INTO snmp_credentials (id, name, description, snmp_version, community)
VALUES (1, 'v2c-public', 'Default SNMPv2c public community', 'v2c', 'public');

-- Wire existing v1/v2c devices to the default credential
UPDATE devices
SET credential_id = 1
WHERE snmp_version IN ('v1', 'v2c') AND credential_id IS NULL;
