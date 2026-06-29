-- Migration 011: Org → Group → Site hierarchy
-- Renames 'site' column to 'groups' (Group level; 'group' is a SQL keyword).
-- Renames 'location' column to 'site' (Site level).
-- Adds new 'org' column (Org level, top of hierarchy).
--
-- Final hierarchy: org (Org) → groups (Group) → site (Site) → devices
ALTER TABLE devices RENAME COLUMN site TO groups;
ALTER TABLE devices RENAME COLUMN location TO site;
ALTER TABLE devices ADD COLUMN org TEXT NOT NULL DEFAULT '';
