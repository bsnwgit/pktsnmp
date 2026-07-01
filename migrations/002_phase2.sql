-- pktSNMP Phase 2 migration
-- Adds: collectors, oid_catalog tables; expands devices table

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Collectors registry
CREATE TABLE IF NOT EXISTS collectors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    ip          TEXT,
    api_token   TEXT UNIQUE,
    last_seen   TEXT,
    status      TEXT NOT NULL DEFAULT 'unknown',
    version     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO collectors (id, name, description, ip)
VALUES (1, 'local', 'Built-in local collector (in-process on O2)', '203.0.113.10');

INSERT OR IGNORE INTO collectors (id, name, description, ip)
VALUES (2, 'medical', 'Medical otelcol collector', '203.0.113.11');

INSERT OR IGNORE INTO collectors (id, name, description, ip)
VALUES (3, 'dental', 'Dental otelcol collector', '203.0.113.12');

-- Expand devices table (ALTER TABLE — each column added individually)
ALTER TABLE devices ADD COLUMN collector_id INTEGER REFERENCES collectors(id) DEFAULT 1;
ALTER TABLE devices ADD COLUMN poll_interval_override INTEGER;
ALTER TABLE devices ADD COLUMN last_seen TEXT;
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN last_error TEXT;
ALTER TABLE devices ADD COLUMN otelcol_label TEXT;
ALTER TABLE devices ADD COLUMN security_name TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN security_level TEXT NOT NULL DEFAULT 'noAuthNoPriv';
ALTER TABLE devices ADD COLUMN auth_protocol TEXT NOT NULL DEFAULT 'SHA256';
ALTER TABLE devices ADD COLUMN auth_key_enc TEXT;
ALTER TABLE devices ADD COLUMN priv_protocol TEXT NOT NULL DEFAULT 'AES128';
ALTER TABLE devices ADD COLUMN priv_key_enc TEXT;

-- Seed live devices (medical collector)
INSERT OR IGNORE INTO devices (name, ip, site, snmp_version, community, collector_id, otelcol_label, enabled)
VALUES
  ('SiteA SW1',     '203.0.113.20',   'medical', 'v3',  '',                 2, 'SiteA/SW1',      1),
  ('SiteA FW3',     '203.0.113.22',  'medical', 'v2c', 'REDACTED_COMMUNITY_STRING', 2, 'SiteA/FW3',      1),
  ('SiteA FW4',     '203.0.113.21',  'medical', 'v2c', 'REDACTED_COMMUNITY_STRING', 2, 'SiteA/FW4',      1),
  ('SiteB SW1', '203.0.113.32', 'medical', 'v2c', 'REDACTED_COMMUNITY_STRING', 2, 'ON/SW1',       1),
  ('SiteB FW1', '203.0.113.30',  'medical', 'v2c', 'REDACTED_COMMUNITY_STRING', 2, 'SiteB/FW1',  1),
  ('SiteB FW2', '203.0.113.31',  'medical', 'v2c', 'REDACTED_COMMUNITY_STRING', 2, 'SiteB/FW2',  1);

-- Seed live devices (dental collector)
INSERT OR IGNORE INTO devices (name, ip, site, snmp_version, community, collector_id, otelcol_label, enabled)
VALUES
  ('AWS AZ2A', '10.19.56.186', 'dental', 'v2c', 'REDACTED_COMMUNITY_STRING', 3, 'AWS/AZ2A', 1),
  ('AWS AZ2B', '10.19.81.236', 'dental', 'v2c', 'REDACTED_COMMUNITY_STRING', 3, 'AWS/AZ2B', 1);

-- OID catalog
CREATE TABLE IF NOT EXISTS oid_catalog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    oid         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT '',
    data_type   TEXT NOT NULL DEFAULT 'string',
    source      TEXT NOT NULL DEFAULT 'bundled',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oid_catalog_oid    ON oid_catalog(oid);
CREATE INDEX IF NOT EXISTS idx_oid_catalog_source ON oid_catalog(source);
CREATE INDEX IF NOT EXISTS idx_devices_collector  ON devices(collector_id);
CREATE INDEX IF NOT EXISTS idx_collectors_token   ON collectors(api_token);
