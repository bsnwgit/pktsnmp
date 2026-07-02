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
VALUES (1, 'local', 'Built-in local collector (in-process on this server)', 'localhost');

-- Remote collector seeds removed — add your own via Settings → Collectors.
-- INSERT OR IGNORE INTO collectors (id, name, description, ip)
-- VALUES (2, 'collector-1', 'Remote otelcol collector 1', 'COLLECTOR-1-IP');
--
-- INSERT OR IGNORE INTO collectors (id, name, description, ip)
-- VALUES (3, 'collector-2', 'Remote otelcol collector 2', 'COLLECTOR-2-IP');

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

-- Device seeds removed — add your devices via Settings → Devices or CSV import.
-- Example (v2c):
--   INSERT OR IGNORE INTO devices (name, ip, site, snmp_version, community, collector_id, otelcol_label, enabled)
--   VALUES ('Core-SW-01', '10.0.0.1', 'site1', 'v2c', 'YOUR-COMMUNITY-STRING', 1, 'SITE1/SW1', 1);
--
-- Example (v3):
--   INSERT OR IGNORE INTO devices (name, ip, site, snmp_version, collector_id, otelcol_label, enabled)
--   VALUES ('Core-FW-01', '10.0.0.2', 'site1', 'v3', 1, 'SITE1/FW1', 1);

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
