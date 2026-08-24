# pktSNMP — User Guide

This guide is for people who use pktSNMP day-to-day to monitor devices, review alerts, and investigate metrics — not for the person installing or administering the server. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for setup, users, backups, and integrations.

## Logging in

Open the app at `http://<server>:8767` (or your configured host/port). Enter your username and password — pressing Enter in either field submits the form. If your organization uses Okta SSO, a "Log in with Okta" option appears alongside the local login form.

If you don't have credentials, ask an administrator to create your account under Settings → Security → Users (admin-only).

Your role (assigned by an admin) determines what you can see and do:

| Action | Admin | Analyst | Viewer |
|---|---|---|---|
| View dashboard / alerts / metrics / logs | ✓ | ✓ | ✓ |
| Acknowledge alerts | ✓ | ✓ | — |
| Add/edit devices | ✓ | ✓ | — |
| Manage collectors, OID catalog, credentials | ✓ | — | — |
| Configure alert rules | ✓ | — | — |
| Manage Settings / users | ✓ | — | — |

## Navigation

The top-level pages are **Dashboard**, **Devices**, **Metrics**, **Alerts**, and **Logs**. **Settings** appears only for admins.

## Dashboard

The landing page gives an at-a-glance view of your SNMP-monitored environment: device status counts, recent alerts, and top interfaces by traffic/error rate. Use it to spot problems quickly before diving into a specific device.

## Devices

Lists every monitored device, organized under the **Org → Group → Site → Location** hierarchy set up by your admin. Click a device to see its detail view — status, interfaces, and recent metric history. Devices that are unreachable or reporting errors are visually flagged.

If a device shows a disabled banner, it means an admin has temporarily disabled polling for it (maintenance, decommission, etc.) — this is expected and not an error on your end.

## Metrics

Browse historical time-series data collected from your devices (interface traffic, errors, discards, CPU/memory where the device exposes it, and other polled OIDs). Use the time-range picker to zoom into a specific window, and per-device/per-interface filters to narrow down what you're looking at.

## Alerts

Shows every alert the alert engine has fired, both currently active and historical. Alerts are generated automatically from rules an admin configures (device down, interface down, flapping links, metric thresholds, error/discard rate spikes, and more). Analysts and admins can **acknowledge** an alert to mark it as seen/being worked — acknowledging doesn't resolve the underlying condition, it just tracks who's on it. Use the page-size selector at the bottom to show more results per page.

## Logs

Search collected SNMP trap and poll-related log activity. Use the filters to narrow by device, severity, or time range.

## Looking up an IP address

Anywhere an IP address appears in the app (a device's IP, a trap source, a log line) it's clickable. Public IP addresses open a lookup modal with geolocation, ASN/organization, abuse history, and blacklist status pulled from whichever external providers you've configured your own API keys for (Settings → User Keys — a per-user setting, not shared across the team). Private/internal addresses (RFC 1918, loopback, link-local) open a simpler internal-info view instead, since public threat-intel providers have nothing useful to say about them.

If the lookup modal shows fewer fields than you expect, it's because you haven't added an API key for that provider yet — this is optional and only affects your own account.

## Finding a setting

The Settings page has a section bar at the top with two buttons: **Common** and **pktSNMP**. Common holds the settings that look the same in every pkt* app (General, Security, Data, Notifications, User Keys, System); pktSNMP holds this app's own (SNMP, Collectors, OID Catalog, Hierarchy). The row of tabs below the section bar shows only the section you've selected, so if a tab you're looking for isn't there, switch sections. Links that point straight at a tab still work — they select the correct section for you.

## The assistant

If your administrator has set it up, a launcher sits in the bottom corner of every page. Click it to ask questions in a chat panel. The panel comes from the resonance server, so what it can help with depends on how your administrator configured it there.

Depending on what your administrator has allowed for your role, it can look at this install's devices, interfaces, collectors, alerts and logs — never anything your own account could not already open, and never an SNMP community string or key. It may also be able to **act**: acknowledge an alert, acknowledge all of them, or switch an alert rule on or off. It will always say exactly what it is about to do and wait for you to say yes.

It can never add, change or delete a device, a collector or a credential, and it cannot make anything poll on demand.

If the launcher never appears, either your role is set to *No access* or the assistant could not load. Your administrator can see both under Settings → Resonance.

## Getting help in the app

Every page and every Settings tab has a small **?** button near the title. Clicking it opens a short explanation of what that page does and any behavior that isn't obvious (for example, "this setting needs a service restart to take effect"). It's static built-in help, not a network call.

For longer-form documentation, click **Documentation** in the sidebar (just above your account info) — it opens this guide and the Administrator Guide as in-app tabs, so you don't need the repo checked out to read them.

## Your account

Click your username in the sidebar to change your own password. If your account uses SSO, password management is handled by your identity provider instead.
