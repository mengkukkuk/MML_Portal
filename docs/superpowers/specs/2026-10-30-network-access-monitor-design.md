# Network access monitor — design

Date: 2026-10-30 · Status: approved in conversation (plan approved 2026-10-30)
Source project: `conn_monitor_py` (standalone Windows connection monitor) — this ports it into MML Portal.

## Intent

Auditors, IT admins and managers need to answer two questions about the machine that hosts MML Portal:

1. **Who reached the MML web app** (HTTPS/HTTP through IIS), when, and for how long.
2. **Who connected by Remote Desktop** to that machine, when, and for how long.

`conn_monitor_py` already answers this for one PC. We move its monitor loop into the FastAPI backend
and add an admin-only page that looks like its `dashboard.html`, restyled in the portal's tokens.

## How the monitor works (unchanged from conn_monitor_py)

Every `interval` seconds (3) the monitor lists ESTABLISHED inbound TCP connections (`psutil`, with a
`netstat -an` fallback), keeps those whose **local port** is watched and whose remote IP passes the
optional prefix filter, and reduces them to a set of `(port, remote IP)` keys.

- Unseen key → open a session (`start = last_seen = now`).
- Seen key → `last_seen = now`.
- Open session whose key is absent and `now - last_seen >= grace` → close it. The recorded end is
  `last_seen`, so grace seconds are never counted as usage. Gaps shorter than grace merge.
- Every tick persists a heartbeat + open sessions (`state.json`). On next boot, sessions found there
  are closed at `min(last_seen, heartbeat)` with note "Interrupted (PC off or monitor stopped)".
  A clean shutdown closes open sessions with note "Monitor stopped".

## Goals

- Backend-resident monitor; no second process or agent.
- Watch web (443, 80) and RDP (3389) on the portal host; ports are configurable.
- One line per ended session appended to `conn_monitor.log`, one folder per day.
- Admin-only page: stat cards, "Connected now", history filtered by **time range**, protocol and text.

## Non-goals

Per-user identity (portal username), UDP, outbound connections, other devices on the network, log
retention/rotation, an auditor role, CSV export.

## Anti-goals

A monitor failure (no psutil, no permission, unwritable log folder) must never stop the API from
booting or serving; it degrades to "monitor not running" on the page.

## Decisions

| Topic | Decision |
|---|---|
| Ports | `ACCESS_PORTS`, default `443:HTTPS:120,80:HTTP:120,3389:RDP:10` (`port:label:grace_seconds`). 8088 is not watched: behind IIS/ARR the API only sees 127.0.0.1. |
| Grace | Per port. Web 120 s because browsers drop and reopen connections; RDP 10 s as before. |
| Loopback | Ignored by default (`ACCESS_IGNORE_LOOPBACK=1`). |
| Log layout | `<ACCESS_LOG_ROOT>/YYYY-MM-DD/conn_monitor.log`, folder = day the session **started**. Line format is the existing `Key: Value \| Key: Value`. |
| Range semantics | A session matches `[from, to]` if it overlaps it. Folders from `from - 1 day` to `to` are scanned (sessions are filed by start day). Range capped at 31 days. |
| Identity | Remote IP + computer name (static names file → cache → NBT/reverse DNS in background). |
| Access | `require_admin` + `require_valid_license`. Route `/access`, sidebar item "Access" next to Accounts. |
| Timestamps | Naive server-local ISO strings, same convention as `report_engine`. |
| Single process | The monitor assumes one API process (NSSM runs one uvicorn). |

## API

- `GET /api/access/status` → `{enabled, running, since, interval_seconds, ports:[{port,label,grace_seconds}], server_time}`
- `GET /api/access/active` → `{server_time, sessions:[{computer_name, remote_ip, protocol, port, connected_since}]}`
- `GET /api/access/history?start&end&protocol&q&limit` → `{rows, total, truncated, files}`; each row has
  `computer_name, remote_ip, protocol, port, start, end, seconds, duration, note`.

## Page

Header with monitor-state pill → four stat cards (Connected now; Sessions in range with "RDP n · Web m";
Unique PCs; Total time) → "Connected now" table (live ticking duration) → History card with a
date-time **range** (two pickers + presets: Last hour, Today, Last 24 h, Last 7 days, Last 30 days),
protocol chips (All / HTTPS / HTTP / RDP) and a search box → footer naming the log files covered.

## Left to the builder

Class and function boundaries, test layout, exact CSS, Thai wording, copy for empty and error states.

## Risks

Multi-worker deployment would double-count. A CDN or extra proxy in front of IIS hides real client
IPs. IP/computer name is not a login identity. Logs hold IPs and names: admin-only, no retention yet.
