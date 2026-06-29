-- pktSNMP migration 006: HA role tagging for devices
-- Adds ha_role column (values: 'active' | 'passive' | 'standalone' | NULL)

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

ALTER TABLE devices ADD COLUMN ha_role TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_ha_role ON devices(ha_role);
