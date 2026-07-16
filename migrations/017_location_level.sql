-- Migration 017: Insert a new "Group" level, shifting the hierarchy down one.
--
-- Old hierarchy: org (Org) -> groups (Group) -> site (Site) -> devices
-- New hierarchy: org (Org) -> groups (Group, NEW/empty) -> site (Site, was Group)
--                -> location (Location, NEW, was Site) -> devices
--
-- i.e. what used to be in "groups" moves to "site", what used to be in "site"
-- moves to the new "location" column, and "groups" starts fresh/empty.

-- ── Devices table: shift plain-text hierarchy columns ──────────────────────────
ALTER TABLE devices RENAME COLUMN site   TO location;
ALTER TABLE devices RENAME COLUMN groups TO site;
ALTER TABLE devices ADD COLUMN groups TEXT NOT NULL DEFAULT '';

-- ── Hierarchy definition tables (pick-lists for device form dropdowns) ─────────
-- Same shift, applied to the orgs -> groups_def -> sites_def pick-list tree.
-- The old groups_def (level 2, FK org_id) becomes the new sites_def (level 3);
-- since the new Group level has no prior data, each org that had groups_def
-- rows gets a single "(Unassigned)" placeholder group to attach its
-- now-Site rows to, so nothing is orphaned and the FK chain stays intact.
-- IDs are preserved across the rename so nothing else needs to change.

CREATE TABLE groups_def_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, name)
);

INSERT INTO groups_def_new (org_id, name)
SELECT DISTINCT org_id, '(Unassigned)' FROM groups_def;

CREATE TABLE sites_def_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES groups_def_new(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, name)
);

INSERT INTO sites_def_new (id, group_id, name, created_at, updated_at)
SELECT g.id, gn.id, g.name, g.created_at, g.updated_at
FROM groups_def g
JOIN groups_def_new gn ON gn.org_id = g.org_id AND gn.name = '(Unassigned)';

CREATE TABLE locations_def_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL REFERENCES sites_def_new(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, name)
);

-- s.group_id here is the OLD groups_def.id, which sites_def_new preserved as
-- its own id above, so this direct copy (no join needed) lands correctly.
INSERT INTO locations_def_new (id, site_id, name, created_at, updated_at)
SELECT s.id, s.group_id, s.name, s.created_at, s.updated_at
FROM sites_def s;

DROP TABLE sites_def;
DROP TABLE groups_def;
ALTER TABLE groups_def_new    RENAME TO groups_def;
ALTER TABLE sites_def_new     RENAME TO sites_def;
ALTER TABLE locations_def_new RENAME TO locations_def;
