-- Migration 006: Add HA role to devices
-- ha_role values: 'active' | 'passive' | 'standalone' | NULL (no HA)
ALTER TABLE devices ADD COLUMN ha_role TEXT;
