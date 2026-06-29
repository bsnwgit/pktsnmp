-- Migration 010: Add location to devices
-- Devices now have site (top level) and location (within a site).
-- Dashboard tree: Site → Location → Root Devices → Child Devices
ALTER TABLE devices ADD COLUMN location TEXT NOT NULL DEFAULT '';
