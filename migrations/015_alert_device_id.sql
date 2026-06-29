-- Migration 015: add device_id column to alert_events
-- Allows the alert engine to record which device triggered the event
-- and the alerts API to JOIN devices for name/IP display.
ALTER TABLE alert_events ADD COLUMN device_id INTEGER REFERENCES devices(id);
