# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MMLPortal** — a SCADA monitoring system. Monorepo with two independent applications:
- `scada-mml-backend/` — FastAPI (Python 3.14) REST API
- `scada-frontend/` — Vue 3 + Vite SPA

A handful of helper utilities sit alongside them:
- `scada-mml-backend/simulate_data.py` — writes fake `public.sensor_readings`
  rows every 5s so the Live/Trends pages have data without a real PLC.
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
.\venv\Scripts\python.exe -m pytest tests/test_db_ops.py::test_name

# Optional — populate live demo data for /live and /trends
.\venv\Scripts\python.exe simulate_data.py            # forever, 5s tick
.\venv\Scripts\python.exe simulate_data.py --seed     # seed 2h history first
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

### Auth Token Strategy
- **Access token**: short-lived JWT (default 30 min), kept in Pinia memory only — never persisted to localStorage
- **Refresh token**: long-lived JWT (default 7 days), set as HttpOnly cookie at path `/api/auth`
- **Reset token**: single-use JWT (30 min) for password reset flow
- Axios interceptor in `scada-frontend/src/api/client.js` handles token refresh transparently

### Backend Layout
| File | Role |
|------|------|
| `main.py` | FastAPI app factory, CORS middleware, router mounts, `init_panels_table()` on startup |
| `auth.py` | 8 auth endpoints (login, register, me, refresh, logout, change-password, forgot-password, reset-password) |
| `users.py` | Admin CRUD at `/api/users` |
| `readings.py` | `/api/readings/*` — devices, metrics, latest reading, sliding-window series (reads `public.sensor_readings`) |
| `tags.py` | `/api/tags/*` — distinct tag names, dynamic numeric fields, latest row from `public.status_tag` |
| `panels.py` | `/api/panels/*` — CRUD for the admin-managed Live dashboard (`dashboard_panels` table); admin token gates writes |
| `security.py` | Password hashing via stdlib `hashlib.scrypt`, JWT sign/verify |
| `db.py` | Psycopg 3 access layer — all SQL lives here, including dynamic `status_tag` column discovery |
| `mailer.py` | Password-reset delivery: **Brevo HTTP API** (preferred) → SMTP fallback → log-only dev mode |
| `config.py` | All env vars with fallback defaults |
| `simulate_data.py` | Standalone CLI that writes synthetic time-series into `sensor_readings` |
| `init_db.sql` | Aspirational multi-schema reference design (core/asset/historian/alarm/…); not consumed by the running app today |

Password hash format: `scrypt$<salt_hex>$<digest_hex>` (no third-party wheel needed for Python 3.14).

### Frontend Layout
- `src/pages/` — one component per route (`OverviewPage`, `DevicesPage`, `AlarmsPage`, `TrendsPage`,
  **`LivePage`** admin-managed live grid, `SettingsPage`, `AccountsPage` admin-only, `LoginPage`,
  `ResetPasswordPage`, `NotFoundPage`); guarded by `requiresAuth` / `requiresRole` in `src/router/index.js`
- `src/stores/` — Pinia stores: `auth`, `users`, `devices`, `alarms`, `connection`
- `src/api/` — thin Axios wrappers per domain (`auth`, `users`, `devices`, `alarms`,
  `readings`, `tags`, `panels`)
- `src/components/` — shared UI: `AppHeader`, `AppSidebar`, `GaugeTile`, `StatCard`,
  `TrendChart`, `GrafanaPanel`, `ConnectionPill`, **`LivePanel`** (Grafana-style single-tile
  renderer used by `LivePage`)
- `src/utils/` — `mathExpr.js` (safe per-panel value-transform evaluator, no `eval`/`Function`),
  `seriesPalette.js` (deterministic per-series colour assignment)

### Live dashboard
`/live` is admin-curated: panels are persisted in Postgres (`dashboard_panels` table)
and each tile self-polls at one of the whitelisted intervals (5s, 30s, 1m, 10m,
30m, 1h). Each panel binds to one of:
- `source='device'` — legacy `device_id` + `metric` from `public.sensor_readings`.
- `source='tag'` — `tag_name` from `public.status_tag`, with the chosen
  numeric column as the metric. Tag fields are discovered dynamically from
  `information_schema` on first request and cached for the process lifetime,
  so new numeric columns appear after a service restart with no schema PR.
  Multi-tag panels (`panel.options.tags`) overlay several tags as separate
  coloured series in one tile.

Per-panel `options.transform` accepts a tiny expression (`value`, `+ - * / ^`,
`abs/sqrt/pow/min/max/floor/ceil/round`) so a raw count can be displayed as
e.g. `value/10`.

### Request Flow (Production)
```
Browser → IIS → /api/* → ARR reverse proxy → FastAPI :8088
               → /*    → dist/ (SPA, falls back to index.html)
```
IIS rewrite rules are in `scada-frontend/public/web.config` (copied to `dist/` on build).

### Required Environment Variables (`scada-mml-backend/.env`)
```
DB_PASSWORD=        # required
JWT_SECRET=         # required — generate: python -c "import secrets; print(secrets.token_hex(32))"
```
See `.env.example` for all options. For password-reset email delivery, set
**`BREVO_API_KEY`** (preferred — Brevo HTTP API needs no IP allow-list) or fall
back to `SMTP_HOST=…`. Leave both empty in dev to log reset links to the
service log instead.

## Key Docs
- `DEVELOPMENT.md` — full architecture reference, every API endpoint, schemas, local dev walkthrough
- `README.md` — production deployment on Windows (NSSM + IIS + PostgreSQL 18) and the one-shot installer
- `workflow.html` — interactive end-to-end system workflow (open in a browser)
- `scada-mml-backend/python-backend-flow.html` — animated per-step backend request flow
- `verify_prod.ps1` — smoke-test script for production health checks
