-- ARP table, routing table, and interface list per device — collected
-- alongside the existing gauge/counter metrics poll (app/snmp/poll_engine.py
-- ::_poll_topology) and exposed read-only via the Suite Integration API so
-- sibling apps (currently pktIPAM) can consume them instead of requiring
-- their own direct SNMP credentials to the same devices. Full-replace on
-- each poll, same pattern as pktIPAM's own arp_entries/routes tables.
CREATE TABLE IF NOT EXISTS arp_entries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ip_address       TEXT NOT NULL,
    mac_address      TEXT,
    interface_label  TEXT,
    vlan_tag         INTEGER,
    last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_arp_entries_device ON arp_entries(device_id);
CREATE INDEX IF NOT EXISTS idx_arp_entries_ip ON arp_entries(ip_address);

CREATE TABLE IF NOT EXISTS routes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    destination      TEXT NOT NULL,   -- CIDR, e.g. 10.0.1.0/24
    next_hop         TEXT,
    interface_label  TEXT,
    protocol         TEXT,            -- local | static | rip | ospf | bgp | eigrp | isis | other
    metric           INTEGER,
    last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, destination, next_hop, interface_label)
);
CREATE INDEX IF NOT EXISTS idx_routes_device ON routes(device_id);
CREATE INDEX IF NOT EXISTS idx_routes_destination ON routes(destination);

CREATE TABLE IF NOT EXISTS interfaces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    if_index    TEXT NOT NULL,
    if_name     TEXT,
    vlan_tag    INTEGER,
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, if_index)
);
CREATE INDEX IF NOT EXISTS idx_interfaces_device ON interfaces(device_id);
