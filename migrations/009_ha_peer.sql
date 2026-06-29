-- Migration 009: HA peer device link
-- Links the active and passive devices in an HA pair so the topology
-- tree can redirect children of the passive device to the active partner.
ALTER TABLE devices ADD COLUMN ha_peer_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;
