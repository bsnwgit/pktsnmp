-- Migration 012: Add device_type to devices
-- Values: firewall, switch, wap, wlc, router, iot, ups, server,
--         storage, pdu, camera, load_balancer, vpn, printer, other, '' (unset)
ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT '';
