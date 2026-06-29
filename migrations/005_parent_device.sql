-- Migration 005: add parent_device_id to devices table
-- Enables hierarchical device topology with alert roll-up on dashboard.
-- ON DELETE SET NULL: deleting a parent promotes its children to root nodes.

ALTER TABLE devices ADD COLUMN parent_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;
