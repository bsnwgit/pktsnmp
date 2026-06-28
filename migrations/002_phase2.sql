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
VALUES (1, 'local', 'Built-in local collector (in-process on O2)', '172.23.80.5');

INSERT OR IGNORE INTO collectors (id, name, description, ip)
VALUES (2, 'medical', 'Medical otelcol collector', '172.23.80.11');

INSERT OR IGNORE INTO collectors (id, name, description, ip)
VALUES (3, 'dental', 'Dental otelcol collector', '10.56.57.181');

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
  ('QTS SW1',     '172.27.28.2',   'medical', 'v3',  '',                 2, 'QTS/SW1',      1),
  ('QTS FW3',     '172.27.28.89',  'medical', 'v2c', '5cNK!ate3RxNALCA', 2, 'QTS/FW3',      1),
  ('QTS FW4',     '172.27.28.88',  'medical', 'v2c', '5cNK!ate3RxNALCA', 2, 'QTS/FW4',      1),
  ('OneNeck SW1', '192.168.44.33', 'medical', 'v2c', '5cNK!ate3RxNALCA', 2, 'ON/SW1',       1),
  ('OneNeck FW1', '192.168.44.7',  'medical', 'v2c', '5cNK!ate3RxNALCA', 2, 'OneNeck/FW1',  1),
  ('OneNeck FW2', '192.168.44.8',  'medical', 'v2c', '5cNK!ate3RxNALCA', 2, 'OneNeck/FW2',  1);

-- Seed live devices (dental collector)
INSERT OR IGNORE INTO devices (name, ip, site, snmp_version, community, collector_id, otelcol_label, enabled)
VALUES
  ('AWS AZ2A', '10.19.56.186', 'dental', 'v2c', '5cNK!ate3RxNALCA', 3, 'AWS/AZ2A', 1),
  ('AWS AZ2B', '10.19.81.236', 'dental', 'v2c', '5cNK!ate3RxNALCA', 3, 'AWS/AZ2B', 1);

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
