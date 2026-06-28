-- pktSNMP SQLite initial migration
-- Manages: users, settings, devices, alert rules, alert events, notification logs

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings  (key/value store for all app configuration)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,         -- JSON-encoded value
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Defaults inserted at first run by the app
-- (storage backend, retention days, SNMP settings, etc.)


-- ─────────────────────────────────────────────────────────────────────────────
-- Users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL UNIQUE,
    hashed_password TEXT,                   -- NULL for Okta-only users
    role            TEXT NOT NULL DEFAULT 'viewer'  -- admin | analyst | viewer
                        CHECK (role IN ('admin', 'analyst', 'viewer')),
    is_active       INTEGER NOT NULL DEFAULT 1,
    auth_provider   TEXT NOT NULL DEFAULT 'local', -- local | saml
    okta_sub        TEXT UNIQUE,            -- Okta subject claim for SSO users
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login      TEXT
);

-- Default admin created by install.sh (password changed on first login)
-- INSERT INTO users (username, email, hashed_password, role)
-- VALUES ('admin', 'admin@local', '<bcrypt_hash>', 'admin');


-- ─────────────────────────────────────────────────────────────────────────────
-- Device registry  (SNMP-polled devices)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip          TEXT NOT NULL UNIQUE,     -- device IP address
    name        TEXT NOT NULL,            -- display name
    site        TEXT NOT NULL DEFAULT '', -- site/location label
    notes       TEXT NOT NULL DEFAULT '',
    snmp_version TEXT NOT NULL DEFAULT 'v2c',  -- v1 | v2c | v3
    community   TEXT NOT NULL DEFAULT 'public',
    enabled     INTEGER NOT NULL DEFAULT 1,   -- 0 = polling disabled
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Alert rules
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    rule_type       TEXT NOT NULL,
    conditions      TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific params
    time_window_min INTEGER NOT NULL DEFAULT 5,
    severity        TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
    channels        TEXT NOT NULL DEFAULT '["inapp"]',  -- JSON array of channel names
    cooldown_min    INTEGER NOT NULL DEFAULT 30,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired      TEXT
);

-- Built-in: alert when a device stops responding to SNMP polls
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (1,
    'Device unreachable',
    'Fires when no SNMP response is received from a monitored device',
    'device_down',
    '{"silence_minutes": 10}',
    'critical',
    '["inapp"]'
);

-- Built-in: alert when an SNMP trap is received from an unregistered device
INSERT OR IGNORE INTO alert_rules (id, name, description, rule_type, conditions, severity, channels)
VALUES (2,
    'Unknown trap source',
    'Fires when an SNMP trap is received from a device not in the registry',
    'unknown_trap_source',
    '{}',
    'warning',
    '["inapp"]'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Alert events  (fired instances of alert rules)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id     INTEGER NOT NULL REFERENCES alert_rules(id),
    severity    TEXT NOT NULL,
    message     TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',  -- JSON: extra context
    fired_at    TEXT NOT NULL DEFAULT (datetime('now')),
    acked_at    TEXT,
    acked_by    INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_alert_events_fired    ON alert_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_acked    ON alert_events(acked_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule     ON alert_events(rule_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- Notification delivery log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES alert_events(id),
    channel     TEXT NOT NULL,    -- email | slack | pagerduty | webhook | inapp
    status      TEXT NOT NULL,    -- sent | failed | skipped
    error       TEXT,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_log_event ON notification_log(event_id);
