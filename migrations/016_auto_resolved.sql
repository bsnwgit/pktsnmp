-- Migration 016: add auto_resolved to alert_events
-- Distinguishes system-cleared events (auto_resolved=1) from user-acked ones.
-- Matches pktFlow pattern for consistent alert UX across the pkt suite.
ALTER TABLE alert_events ADD COLUMN auto_resolved INTEGER NOT NULL DEFAULT 0;
