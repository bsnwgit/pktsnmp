-- Migration 014: add resolved_at to alert_events for auto-resolution support
ALTER TABLE alert_events ADD COLUMN resolved_at TEXT;
