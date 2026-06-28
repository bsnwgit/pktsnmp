-- pktSNMP migration 005: add resolved_at to alert_events
-- Supports auto-resolve: engine marks events resolved when the condition clears.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE alert_events ADD COLUMN resolved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_alert_events_resolved ON alert_events(resolved_at);
