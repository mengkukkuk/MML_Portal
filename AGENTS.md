# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**MMLPortal** — a SCADA monitoring system. Monorepo with two independent applications:
- `scada-mml-backend/` — FastAPI (Python 3.14) REST API
- `scada-frontend/` — React 19 + Vite SPA (converted from Vue on the `react_cvt` branch)

A handful of helper utilities sit alongside them:
- `scada-mml-backend/simulate_data.py` — writes fake `public.sensor_readings`
  rows every 5s so the Live/Trends pages have data without a real PLC.
- `scada-mml-backend/simulate_events.py` — writes synthetic machine state transitions
  (RUN/STOP/IDLE/PLANNED_DOWN) into `public.event_logs` and alarms for report testing.
- `scada-mml-backend/install.ps1` / `uninstall.ps1` (with matching `.bat` shims)
  — one-shot interactive installers that build the venv, patch `.env`,
  optionally seed the DB, and register the `mml-api` NSSM service.

## Commands

### Backend
```bash
cd scada-mml-backend

# Setup (first time)
py -3.14 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe seed_users.py   # migrate users table + seed mock users

# Dev server (0.0.0.0:8088)
.\venv\Scripts\python.exe main.py

# Tests
.\venv\Scripts\python.exe -m pytest tests/
# Single test
.\venv\Scripts\python.exe -m pytest tests/test_report_engine.py::test_name

# Optional — populate live demo data for /live and /trends.
# These write *plant* tables, which no longer live in the app DB, so a target is
# required: a saved datasource (by id or name) or a raw DSN.
.\venv\Scripts\python.exe simulate_data.py --datasource 1           # forever, 5s tick
.\venv\Scripts\python.exe simulate_data.py --datasource 1 --seed    # seed 2h history first
.\venv\Scripts\python.exe simulate_data.py --dsn "host=… dbname=… user=… password=…"
```

### Frontend
```bash
cd scada-frontend

npm install
npm run dev      # http://localhost:5173, proxies /api → 127.0.0.1:8088
npm run build    # outputs to dist/
npm run preview  # preview production build locally
```

### Windows service (production)
```powershell
# Interactive installer (self-elevates). Creates venv, patches .env,
# seeds DB, registers NSSM service, runs /health smoke test.
cd C:\dev\scada-mml-backend
.\install.ps1                # bind 127.0.0.1:8088 (behind IIS)
.\install.ps1 -BindHost 0.0.0.0   # standalone direct access
.\uninstall.ps1              # stop + remove service
```

## Architecture

### App/config database vs plant data
The single most important split in this codebase.

- The **app/config database is hardcoded** to `localhost:5432` / `postgres` / `postgres` /
  `P@ssw0rd` (`config.APP_DB_*`). `.env` has no `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`
  and setting them does nothing. It holds users, selections, dashboards, panels, mimic
  layouts/assets/symbols, report templates/settings, and the `datasources` table itself.
  Login, layout and settings therefore work even when every plant is unreachable.
- **All plant data** — `sensor_readings`, `variables_tag`, `event_logs`, `alarm_logs` — is
  read from the rows of `datasources` the current user has selected in the header
  (`user_datasource_selection`, resolved from the JWT by `auth.resolve_active_datasources`).
  No explicit selection falls back to the lowest-id datasource, flagged `implicit: true`.
- **The header selection overrides everything.** A panel's or symbol's stored
  `datasource_id` is not consulted for reads.
- Reads **fan out** across the selection via `db.fan_out` / `db.fan_out_rows` (threaded,
  bounded pool). Every response is `{"<rows>": [...], "sources": [...]}` and every row is
  stamped `datasource_id` / `datasource_name` — a plant that failed must be distinguishable
  from a plant with nothing to report.
- Ids are **per-database serials and collide across plants**. Machine identity is
  `(datasource_id, location, tag_name)`; React keys need the source in them.
- Live fans out one series per source; Events/Alarms merge; Monitor mimic symbols use the
  **first** selected source only. Writes (e.g. alarm acknowledge) never fan out.

### Auth Token Strategy
- **Access token**: short-lived JWT (default 30 min), kept in module memory (`src/api/client.js`) only — never persisted to localStorage
- **Refresh token**: long-lived JWT (default 7 days), set as HttpOnly cookie at path `/api/auth`
- **Reset token**: single-use JWT (30 min) for password reset flow
- Axios interceptor in `scada-frontend/src/api/client.js` handles token refresh transparently

### Backend Layout
| File | Role |
|------|------|
| `main.py` | FastAPI app factory, CORS middleware, 12 router mounts, `init_*` table-creation calls on startup |
| `auth.py` | 8 auth endpoints (login, register, me, refresh, logout, change-password, forgot-password, reset-password) |
| `users.py` | Admin CRUD at `/api/users` |
| `readings.py` | `/api/readings/*` — devices, metrics, latest reading, sliding-window series (reads `public.sensor_readings`) |
| `tags.py` | `/api/tags/*` — distinct tag names, dynamic numeric fields, latest row from `public.variables_tag` |
| `panels.py` | `/api/panels/*` — CRUD for the admin-managed Live dashboard (`dashboard_panels` table); admin token gates writes |
| `schema.py` | `/api/schema/*` — table/column introspection for generic data source bindings in Live panels |
| `dashboards.py` | `/api/dashboards/*` — multi-board grouping for Live panels (admin token gates writes) |
| `datasources.py` | `/api/datasources/*` — plant connection CRUD (admin gates writes; test endpoint probes real connections) **and** `/selection` GET/PUT/DELETE, the per-user header choice (any role, max 8) |
| `sources.py` | `SourceReport` — the per-source `ok`/`error` block every fanned-out response carries, plus a tz-safe sort key for merging plants |
| `mimic.py` | `/api/mimic/*` — layout CRUD for `/monitor` drawings, asset uploads, symbol/wire binding validation (admin token gates writes) |
| `events.py` | `/api/events/*` — read-only event-log endpoints backing the Events page |
| `alarms.py` | `/api/alarms/*` — read-only alarm-log endpoints with Acknowledge action for the Alarms page |
| `reports.py` | `/api/reports/*` — OEE/MES reporting: template CRUD (admin token gates template writes), report runs, CSV/Excel export |
| `report_engine.py` | Pure state-interval arithmetic — turns `public.event_logs` transitions into machine runtime/downtime/OEE metrics |
| `security.py` | Password hashing via stdlib `hashlib.scrypt`, JWT sign/verify |
| `db.py` | Psycopg 3 access layer — all SQL lives here. `get_connection()` is **always the localhost app DB**; plant SQL goes through the per-datasource pools and `fan_out`/`fan_out_rows`. Also dynamic `variables_tag` column discovery and table init helpers |
| `mailer.py` | Password-reset delivery: **Brevo HTTP API** (preferred) → SMTP fallback → log-only dev mode |
| `config.py` | All env vars with fallback defaults, plus the hardcoded `APP_DB_*` constants |
| `migrate_config_to_local.py` | One-shot: copy config tables from an old remote DB to localhost. Dry-run by default, `--apply` to write |
| `plant_cli.py` | Shared `--datasource` / `--dsn` target resolution for the CLI helpers below (they write plant tables, so localhost would be wrong) |
| `simulate_data.py` | Standalone CLI that writes synthetic time-series into a plant's `sensor_readings` |
| `simulate_events.py` | Standalone CLI that writes machine state transitions and alarms into a plant's `event_logs`/`alarm_logs` for report demos |
| `init_db.sql` | Aspirational multi-schema reference design (core/asset/historian/alarm/…); not consumed by the running app today |

Password hash format: `scrypt$<salt_hex>$<digest_hex>` (no third-party wheel needed for Python 3.14).

### Frontend Layout
- `src/pages/` — root pages: `OverviewPage`, `DevicesPage`, `AlarmsPage`, `EventPage`, `LoginPage`,
  `ResetPasswordPage`, `SettingsPage`, `AccountsPage` (admin-only), `NotFoundPage`; plus subdirs:
  - `pages/live/` — **`LivePage`** (admin-managed live grid), `DashboardSwitcher`, `PanelEditorDialog`, `ParamFields`, `panelPayload.js`
  - `pages/monitor/` — **`MonitorPage`** (interactive SCADA mimic), `MimicCanvas`, `MimicSwitcher`, `DetailRail`, `NodeInspector`, `EdgeInspector`, `SymbolPalette`, `SymbolBindingDialog`, `CustomSymbolDialog`, `WirePicker`, `defaultLayout.js`, `layoutDoc.js`
  - `pages/reports/` — **`ReportPage`** (viewer), `ReportBuilderPage` (admin-only template editor)
  - All guarded by `RequireAuth` element wrapper in `src/router/routes.jsx` (react-router-dom v7 `createBrowserRouter`)
- `src/stores/` — Zustand stores: `auth`, `users`, `devices`, `alarms`, `connection`
- `src/api/` — thin Axios wrappers per domain (`auth`, `users`, `devices`, `alarms`, `readings`, `tags`,
  `panels`, `dashboards`, `datasources`, `schema`, `events`, `mimic`, `mimicAssets`, `reports`)
- `src/components/` — shared UI: `AppHeader`, `AppSidebar`, `GaugeTile`, `StatCard`, `TrendChart`,
  `ConnectionPill`, plus subdirs:
  - `components/live/` — **`LivePanel`** (Grafana-style single-tile renderer), `usePanelPolling.js`, `usePanelSeries.js`
  - `components/charts/` — `EChart.jsx` (echarts wrapper)
  - `components/mimic/` — symbol rendering: `symbols/` with per-device-type React components (Ats.jsx, Crah.jsx, Generator.jsx, Ups.jsx, Pdu.jsx, Rack.jsx, IpCamera.jsx, Lighting.jsx, ColdAisle.jsx, PcBased.jsx, CustomSymbol.jsx); plus `dynamics.js`, `wireTypes.jsx`, helpers (`deriveTag.js`, `useAssetUrl.js`, `useMimicPlant.js`, `useMockPlant.js`, `usePlantData.js`, `useValueTransition.js`, `tagStatus.js`, `mockPlant.js`), `InstrumentBubble.jsx`
  - `components/report/` — `ReportFilterBar.jsx`, `reportFormat.js`, `reportRange.js`, plus `blocks/` with KpiStrip, SummaryTable, AlarmSummary, DowntimePareto, StateTimeline, RawLogTable, ReportBlock
- `src/utils/` — `mathExpr.js` (safe per-panel value-transform evaluator, no `eval`/`Function`),
  `seriesPalette.js` (deterministic per-series colour assignment), `reportExport.js` (CSV/Excel export)

### Live dashboard
`/live` is admin-curated: panels are persisted in Postgres (`dashboard_panels` table)
and each tile self-polls at one of the whitelisted intervals (5s, 30s, 1m, 10m,
30m, 1h). Each panel binds to one of:
- `source='device'` — legacy `device_id` + `metric` from `public.sensor_readings`.
- `source='tag'` — `tag_name` from `public.variables_tag`, with the chosen
  numeric column as the metric. Tag fields are discovered dynamically from
  `information_schema` on first request and cached for the process lifetime,
  so new numeric columns appear after a service restart with no schema PR.
  Multi-tag panels (`panel.options.tags`) overlay several tags as separate
  coloured series in one tile.

Per-panel `options.transform` accepts a tiny expression (`value`, `+ - * / ^`,
`abs/sqrt/pow/min/max/floor/ceil/round`) so a raw count can be displayed as
e.g. `value/10`.

### Monitor / mimic page
`/monitor` is the interactive SCADA mimic diagram: `MimicCanvas.jsx` renders draggable/resizable
symbols and wires bound to live tags. The full layout (`mimic_layouts` table) persists server-side
via `mimic.py` endpoints, fetched at page load. Each symbol node binds to a tag via `NodeInspector.jsx`
and `SymbolBindingDialog.jsx` (resolved to column paths by `deriveTag.js`). Edges (wires) connect
nodes and are inspected/bound via `EdgeInspector.jsx` and `WirePicker.jsx` — wire styling is defined
in `wireTypes.jsx`. Custom symbols can be uploaded as SVG/PNG via `CustomSymbolDialog.jsx` —
assets are stored server-side and retrieved via `mimicAssets.js` API and `useAssetUrl.js` hook.

### Reports
The reporting feature generates OEE and production dashboards from machine state transitions
in `public.event_logs` and alarm records. The backend (`reports.py` + `report_engine.py`) converts
discrete state-change events into time-interval durations (RUN/STOP/IDLE/PLANNED_DOWN) and computes
KPIs (overall equipment effectiveness, downtime, runtime). The frontend splits report access into
two flows: `ReportPage.jsx` (any authenticated user) views pre-built reports; `ReportBuilderPage.jsx`
(admin-only) edits report templates. Both pull data via a single `/api/reports/run` endpoint that
ensures all blocks (KPI strip, Gantt, Pareto, summary table) see the same state intervals.
Reports render via modular blocks in `components/report/blocks/` (KpiStrip, SummaryTable, AlarmSummary,
DowntimePareto, StateTimeline, RawLogTable) and export via CSV or Excel (`reportExport.js`).

### Request Flow (Production)
```
Browser → IIS → /api/* → ARR reverse proxy → FastAPI :8088
               → /*    → dist/ (SPA, falls back to index.html)
```
IIS rewrite rules are in `scada-frontend/public/web.config` (copied to `dist/` on build).

### Required Environment Variables (`scada-mml-backend/.env`)
```
JWT_SECRET=         # required — generate: python -c "import secrets; print(secrets.token_hex(32))"
```
There is deliberately **no** `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` — the app
database is hardcoded (see above) and plant credentials live in the `datasources` table.
`DB_CONNECT_TIMEOUT` is the only DB knob left; it bounds each fan-out leg.
See `.env.example` for all options. For password-reset email delivery, set
**`BREVO_API_KEY`** (preferred — Brevo HTTP API needs no IP allow-list) or fall
back to `SMTP_HOST=…`. Leave both empty in dev to log reset links to the
service log instead.

## Key Docs
- `MML_DEVELOPMENT.md` — full architecture reference, every API endpoint, schemas, local dev walkthrough
- `README.md` — production deployment on Windows (NSSM + IIS + PostgreSQL 18) and the one-shot installer
- `workflow.html` — interactive end-to-end system workflow (open in a browser)
- `scada-mml-backend/python-backend-flow.html` — animated per-step backend request flow
- `verify_prod.ps1` — smoke-test script for production health checks
