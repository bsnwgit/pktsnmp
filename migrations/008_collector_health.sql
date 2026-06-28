-- pktSNMP migration 008: Collector health tracking
-- Adds auth-failure counters to support 3-state Online/Offline/Error status.
-- effective_status is derived at query time (not stored) from last_seen + these columns.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE collectors ADD COLUMN auth_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collectors ADD COLUMN last_auth_failure_at DATETIME;
