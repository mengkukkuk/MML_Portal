# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MMLPortal** — a SCADA monitoring system. Monorepo with two independent applications:
- `scada-mml-backend/` — FastAPI (Python 3.14) REST API
- `scada-frontend/` — Vue 3 + Vite SPA

## Commands

### Backend
```bash
cd scada-mml-backend

# Setup (first time)
py -3.14 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe seed_users.py   # migrate DB + seed mock users

# Dev server (0.0.0.0:8088)
.\venv\Scripts\python.exe main.py

# Tests
.\venv\Scripts\python.exe -m pytest tests/
# Single test
.\venv\Scripts\python.exe -m pytest tests/test_db_ops.py::test_name
```

### Frontend
```bash
cd scada-frontend

npm install
npm run dev      # http://localhost:5173, proxies /api → 127.0.0.1:8088
npm run build    # outputs to dist/
npm run preview  # preview production build locally
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
| `main.py` | FastAPI app factory, CORS middleware, router mounts |
| `auth.py` | 8 auth endpoints (login, register, me, refresh, logout, change-password, forgot-password, reset-password) |
| `users.py` | Admin CRUD at `/api/users` |
| `security.py` | Password hashing via stdlib `hashlib.scrypt`, JWT sign/verify |
| `db.py` | Psycopg 3 access layer — all SQL lives here |
| `mailer.py` | SMTP delivery; if `SMTP_HOST` is unset, logs the reset link instead |
| `config.py` | All env vars with fallback defaults |

Password hash format: `scrypt$<salt_hex>$<digest_hex>` (no third-party wheel needed for Python 3.14).

### Frontend Layout
- `src/pages/` — one component per route; guarded by `requiresAuth` / `requiresRole` in `src/router/index.js`
- `src/stores/` — Pinia stores: `auth`, `users`, `devices`, `alarms`, `connection`
- `src/api/` — thin Axios wrappers per domain (auth, users, devices, alarms)
- `src/components/` — shared UI: `GaugeTile`, `TrendChart`, `GrafanaPanel`, `ConnectionPill`

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
See `.env.example` for all options. Leave `SMTP_HOST` empty in dev to log reset links to console.

## Key Docs
- `DEVELOPMENT.md` — full architecture reference, all API endpoints, local dev walkthrough
- `README.md` — production deployment on Windows (NSSM + IIS + PostgreSQL 18)
- `verify_prod.ps1` — smoke-test script for production health checks