# SCADA Stack — Development Guide

End-to-end developer documentation for the SCADA monitoring system: a FastAPI backend with
JWT auth backed by PostgreSQL, and a Vue 3 + Vite single-page frontend. Covers local
development, the auth system, live-dashboard internals, running as a Windows service (NSSM)
either via the one-shot installer or by hand, and production deployment behind IIS.

---

## 1. Architecture

```
                 Browser
                    │
        ┌───────────▼────────────┐         ┌──────────────────────────┐
        │   IIS site (prod)       │  /api/* │  mml-api (FastAPI)      │
        │   serves dist/ (SPA)    ├────────▶│  uvicorn @ 127.0.0.1:8088 │
        │   ARR reverse proxy     │  /ws    │  NSSM Windows service     │
        └─────────────────────────┘         └────────────┬─────────────┘
              (dev: Vite @ 5173                           │
               proxies /api → 8088)                       ▼
                                              ┌──────────────────────────┐
                                              │  PostgreSQL 18            │
                                              │  localhost:5432           │
                                              │  users, devices,          │
                                              │  sensor_readings,         │
                                              │  variables_tag (live SCADA), │
                                              │  dashboard_panels         │
                                              └──────────────────────────┘

  Live data path:
      simulate_data.py  ──▶ sensor_readings  ──┐
      SCADA / PLC stack ──▶ variables_tag        ──┴──▶ /api/readings, /api/tags
                                                       ▲
                                                       │ poll every 5s–1h
                                                  LivePage tiles
```

- **Backend** terminates auth, exposes the historian / tag endpoints the Live & Trends
  pages read, and persists the admin-managed live dashboard layout.
- **`simulate_data.py`** writes synthetic readings into `sensor_readings` so the UI has
  data during development. In production, real PLCs/SCADA writes `variables_tag` directly;
  the API only reads.
- **Grafana** (optional) reads Postgres directly for richer dashboards; the embedded
  Grafana panel lives in `GrafanaPanel.vue` on the Trends page.
- The previous direct PLC-over-WebSocket integration (`pymcprotocol`) was **removed**.

---

## 2. Tech stack

| Layer    | Technology |
|----------|------------|
| Backend  | Python 3.14, FastAPI 0.136, Uvicorn 0.48, psycopg 3.3 (binary), PyJWT 2.13, python-dotenv |
| Auth     | JWT (HS256) access + refresh + reset tokens; password hashing via stdlib `hashlib.scrypt` |
| Database | PostgreSQL 18 (`postgresql-x64-18`), localhost:5432 |
| Frontend | Vue 3.5, Vite 8, vue-router 5, Pinia 3, axios, Element Plus, ECharts (`vue-echarts`) |
| Service  | NSSM (runs uvicorn as a Windows service `mml-api`); installer at `scada-mml-backend\install.ps1` |
| Web host | IIS + URL Rewrite + Application Request Routing (ARR) |
| Email    | Brevo transactional HTTP API (preferred) or generic SMTP relay |

> **Why scrypt instead of bcrypt/passlib?** Python 3.14 is bleeding-edge; `bcrypt`/`passlib`
> compiled wheels are unreliable. `hashlib.scrypt` is in the standard library — zero wheel risk.
> `psycopg[binary]` and `PyJWT` both ship cp314 wheels, so they install cleanly.

---

## 3. Repository layout

```
C:\dev\
├── scada-mml-backend\            # FastAPI backend
│   ├── main.py                   # App factory: CORS (explicit origins, credentials=true),
│   │                               mounts auth+users+readings+tags+panels routers, /health,
│   │                               calls db.init_panels_table() on startup, runs on :8088
│   ├── config.py                 # Loads .env (DB, JWT, account, Brevo, SMTP, cookie)
│   ├── db.py                     # psycopg 3 access layer (users CRUD, devices, sensor_readings,
│   │                               variables_tag with dynamic numeric-column discovery,
│   │                               dashboard_panels CRUD)
│   ├── security.py               # scrypt hashing + JWT create/decode (access/refresh/reset)
│   ├── auth.py                   # /api/auth router
│   ├── users.py                  # /api/users router — admin CRUD with last-admin guards
│   ├── readings.py               # /api/readings router — devices, metrics, latest, series
│   ├── tags.py                   # /api/tags router — tag names, dynamic fields, latest row
│   ├── panels.py                 # /api/panels router — admin-managed Live dashboard CRUD
│   ├── mailer.py                 # Brevo HTTP API → SMTP fallback → log-only reset delivery
│   ├── seed_users.py             # Creates/migrates users table + seeds mock users
│   ├── simulate_data.py          # Writes synthetic sensor_readings every 5s (CLI)
│   ├── install.ps1 + install.bat # One-shot interactive installer (self-elevates)
│   ├── uninstall.ps1 + .bat      # Stop + remove the NSSM service
│   ├── nssm.exe                  # Vendored NSSM binary used by install.ps1
│   ├── init_db.sql               # Aspirational multi-schema reference design (not loaded today)
│   ├── tests\                    # pytest suite
│   ├── requirements.txt
│   ├── .env                      # Local secrets (NOT committed)
│   ├── .env.example
│   ├── logs\                     # NSSM stdout/stderr (in addition to C:\inetpub\mml-api\logs)
│   ├── python-backend-flow.html  # Animated request-flow visualization
│   └── venv\                     # Python 3.14 virtual environment
│
├── scada-frontend\               # Vue 3 + Vite SPA
│   ├── src\
│   │   ├── api\                  # client.js (axios; access-token in module memory),
│   │   │                           auth.js, users.js, devices.js, alarms.js,
│   │   │                           readings.js, tags.js, panels.js
│   │   ├── stores\               # Pinia: auth.js, users.js, devices.js, alarms.js, connection.js
│   │   ├── pages\                # LoginPage, ResetPasswordPage (public);
│   │   │                           Overview, Devices, Alarms, Trends, Live,
│   │   │                           Settings, AccountsPage (admin), NotFoundPage
│   │   ├── components\           # AppHeader, AppSidebar, ConnectionPill, GaugeTile, StatCard,
│   │   │                           TrendChart, GrafanaPanel, LivePanel
│   │   ├── utils\                # mathExpr.js (safe transform evaluator),
│   │   │                           seriesPalette.js (deterministic colour pick)
│   │   ├── router\index.js       # Routes + requiresAuth + requiresRole guards;
│   │   │                           auth.initialize() on first navigation
│   │   └── ...
│   ├── public\web.config         # IIS config (copied into dist on build)
│   ├── dist\                     # Production build output (deploy this to IIS)
│   ├── vite.config.js            # Dev proxy /api,/ws → 127.0.0.1:8088
│   └── package.json
│
├── workflow.html                 # Top-level interactive system workflow (open in browser)
├── README.md                     # Deployment guide (install / configure / deploy / troubleshoot)
├── DEVELOPMENT.md                # This file — developer reference
└── verify_prod.ps1               # Admin script: verifies service + IIS reverse proxy
```

`dist\` is the artifact deployed to IIS; everything else under `scada-frontend\` is source.

---

## 4. Prerequisites

- **Python 3.14** (backend venv lives at `scada-mml-backend\venv` — `install.ps1` creates it)
- **Node.js 20+** and npm (frontend)
- **PostgreSQL 18** running on `localhost:5432` (service `postgresql-x64-18`)
- For production: **IIS** with **URL Rewrite 2.x** and **Application Request Routing 3.x**, plus
  the **WebSocket Protocol** feature; **NSSM** for the backend service. A copy of `nssm.exe`
  is vendored at `scada-mml-backend\nssm.exe` so the installer Just Works.

---

## 5. Backend — local development

```powershell
cd C:\dev\scada-mml-backend

# 1. (first time) install dependencies into the venv
py -3.14 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. configure environment — copy the example and fill DB_PASSWORD
Copy-Item .env.example .env    # then edit .env

# 3. seed the database (creates users table + mock users; idempotent)
.\venv\Scripts\python.exe seed_users.py

# 4. run the API (dev)
.\venv\Scripts\python.exe main.py
#    → http://0.0.0.0:8088   |   Swagger UI: http://localhost:8088/docs

# 5. (optional) keep sensor_readings flowing so /live and /trends have data
.\venv\Scripts\python.exe simulate_data.py            # forever
.\venv\Scripts\python.exe simulate_data.py --seed     # seed 2h history first
```

`main.py` has an `if __name__ == "__main__"` block that launches uvicorn, so `python main.py`
fully starts the server (important — a bare FastAPI app object does nothing on its own).
Startup also calls `db.init_panels_table()` so the Live grid table is created/migrated
without a manual SQL step.

### `.env` reference

The full reference (~25 keys, grouped DB / JWT / Account / Brevo / SMTP / CORS / Cookie) lives in
[`README.md` §4 Configuration](README.md#4-configuration). The bare minimum to start the backend:

| Key                  | Default     | Purpose |
|----------------------|-------------|---------|
| `DB_PASSWORD`        | *(blank)*   | **Required** — Postgres password |
| `JWT_SECRET`         | dev value   | HMAC secret — generate with `python -c "import secrets;print(secrets.token_hex(32))"` |
| `APP_BASE_URL`       | `http://localhost:5173` | Base URL used to build password-reset links in emails |

Optional sections covered in the README: token lifetimes (`ACCESS_EXPIRE_MIN`, `REFRESH_EXPIRE_DAYS`,
`RESET_EXPIRE_MIN`, `MIN_PASSWORD_LEN`), **Brevo HTTP delivery (`BREVO_API_KEY`)**, SMTP relay
fallback (`SMTP_*`), CORS allow-list (`CORS_ORIGINS`), and the HTTPS-only cookie flag
(`COOKIE_SECURE`).

---

## 6. Database

### 6.1 Tables the running app uses

```sql
-- users (created/migrated by seed_users.py)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- scrypt$<salt_hex>$<hash_hex>
  role          TEXT NOT NULL DEFAULT 'operator',
  display_name  TEXT NOT NULL,
  email         TEXT,                    -- optional, partial unique index below
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON users (lower(email)) WHERE email IS NOT NULL;

-- dashboard_panels (created/migrated by db.init_panels_table() on startup)
CREATE TABLE IF NOT EXISTS dashboard_panels (
  id             SERIAL PRIMARY KEY,
  title          TEXT NOT NULL,
  device_id      INTEGER,                -- source='device' only
  metric         TEXT,                   -- column / metric name
  window_minutes INTEGER NOT NULL DEFAULT 15,
  chart_type     TEXT NOT NULL DEFAULT 'timeseries',
  position       INTEGER NOT NULL DEFAULT 0,
  options        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source         TEXT NOT NULL DEFAULT 'device',  -- 'device' | 'tag'
  tag_name       TEXT,                            -- source='tag' only
  poll_interval_seconds INTEGER NOT NULL DEFAULT 5,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- devices + sensor_readings (populated by simulate_data.py in dev; by your own
-- ingest pipeline in prod). Schema is implicit — see simulate_data.py for shape.
-- public.variables_tag is supplied by the real SCADA system; the backend just reads it.
```

The `users_email_lower_key` index is **partial** (only enforced where `email IS NOT NULL`)
and case-insensitive, matching `db.get_user_by_email()`'s `lower(email) = lower(%s)` lookup.

`init_db.sql` defines a much larger multi-schema reference design (core/asset/historian/
alarm/dashboard/report/integration/audit) — useful as a north star but **not** loaded by
the running app today.

### 6.2 Dynamic `variables_tag` introspection

`public.variables_tag` is owned by the SCADA system and may grow new numeric columns over
time. Rather than redeploy on every column change, `db._discover_tag_fields()` queries
`information_schema.columns` on first call and caches the result for the process lifetime
(`db._tag_fields_cache`). The DB exposes the legacy "current value" as
`current_value_tag` but the API surfaces it as `current_value` so existing panels keep
working. **New columns appear after restarting the `mml-api` service.**

### 6.3 Mock users (for testing)

| Username   | Password      | Role      | Display name   | Email                   |
|------------|---------------|-----------|----------------|-------------------------|
| `admin`    | `admin123`    | `admin`   | Administrator  | `admin@scada.local`     |
| `operator` | `operator123` | `operator`| Line Operator  | `operator@scada.local`  |

Inspect from a shell:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -h localhost `
  -c "SELECT id, username, role, display_name, email FROM users ORDER BY id;"
```

To add a user programmatically, hash with `security.hash_password()` and insert; or add an entry
to `MOCK_USERS` in `seed_users.py` and re-run it.

---

## 7. API reference

All endpoints return JSON. Access tokens are sent as `Authorization: Bearer <token>`. The refresh
token is **never** in the response body or any request body — it lives in an HttpOnly cookie that
the browser sends automatically to `/api/auth/refresh` and `/api/auth/logout`.

### 7.1 `/api/auth` — authentication & self-service

| Method | Path                          | Body                                          | Success response |
|--------|-------------------------------|-----------------------------------------------|------------------|
| POST   | `/api/auth/login`             | `{username, password}`                        | `{access_token, expires_in, user:{id,username,role,display_name}}` (refresh → cookie) |
| POST   | `/api/auth/register`          | `{username, password, display_name, email?}` | `201` + same shape as login. **Always** creates an operator (never admin). |
| GET    | `/api/auth/me`                | — (Bearer)                                    | `{id, username, role, display_name}` |
| POST   | `/api/auth/refresh`           | — (HttpOnly cookie only)                      | `{access_token, expires_in, user}` |
| POST   | `/api/auth/logout`            | — (HttpOnly cookie only)                      | `204 No Content` (server clears the cookie + denylists the refresh `jti`) |
| POST   | `/api/auth/change-password`   | `{old_password, new_password}` (Bearer)       | `{message}` |
| POST   | `/api/auth/forgot-password`   | `{email}`                                     | `{message}` — generic (no email-exists leak). Sends/logs a reset link. |
| POST   | `/api/auth/reset-password`    | `{token, new_password}`                       | `{message}`; **400** on bad/expired/used token (not 401, so the public reset page shows the real error). |

### 7.2 `/api/users` — admin user management

All endpoints require `Authorization: Bearer <admin-access-token>` (`require_admin` dependency
returns **403** for non-admins). Guards prevent self-delete and removing/demoting the last admin.

| Method | Path                  | Body                                          | Success response |
|--------|-----------------------|-----------------------------------------------|------------------|
| GET    | `/api/users`          | —                                             | `[{id, username, role, display_name, email?, created_at}, ...]` |
| POST   | `/api/users`          | `{username, password, role, display_name, email?}` | `201` + user object |
| PUT    | `/api/users/{id}`     | `{role, display_name, email?}`                | user object (200) |
| DELETE | `/api/users/{id}`     | —                                             | `204 No Content` |

Validation: `role ∈ {admin, operator}`; `password` length ≥ `MIN_PASSWORD_LEN`; duplicate
username/email → `409 Conflict`.

### 7.3 `/api/readings` — historian (Bearer, any role)

Reads from `public.sensor_readings` joined with `public.devices`. Powers the
`device`-source Live panels and the Trends page.

| Method | Path                          | Query                                          | Success response |
|--------|-------------------------------|------------------------------------------------|------------------|
| GET    | `/api/readings/devices`       | —                                              | `[{id, name, type?, location?, status?}]` |
| GET    | `/api/readings/metrics`       | `device_id`                                    | `[{metric, unit?}]` |
| GET    | `/api/readings/latest`        | `device_id`, `metric`                          | `{device_id, metric, unit?, ts, value}` — **404** if no rows |
| GET    | `/api/readings/series`        | `device_id`, `metric`, `minutes` (1..1440, default 15) | `{device_id, metric, unit?, points:[{ts,value}]}` |

### 7.4 `/api/tags` — status-tag (Bearer, any role)

Reads from `public.variables_tag`. The DB row is updated in place by the SCADA system; the
frontend builds its own series by polling at the panel's configured interval.

| Method | Path                | Query        | Success response |
|--------|---------------------|--------------|------------------|
| GET    | `/api/tags`         | —            | `[{tag_name}]` — distinct names |
| GET    | `/api/tags/fields`  | —            | `[{field, label}]` — numeric columns of `public.variables_tag` a panel can bind to (dynamic) |
| GET    | `/api/tags/latest`  | `tag_name`   | `{tag_name, active?, ts?, <discovered_field>: float, ...}` — **404** if no row |

The `LatestOut` model uses `extra='allow'`, so any new numeric column discovered in
`variables_tag` passes through to clients without a Pydantic schema change.

### 7.5 `/api/panels` — admin-managed Live dashboard

Reads are open to any authenticated user (the Live grid renders for everyone); **writes
require an admin token**.

| Method | Path                  | Body / Auth                                                                          | Success response |
|--------|-----------------------|--------------------------------------------------------------------------------------|------------------|
| GET    | `/api/panels`         | Bearer                                                                               | `[PanelOut, ...]` ordered by `position` |
| POST   | `/api/panels`         | Bearer admin + `PanelIn`                                                             | `201` + `PanelOut` |
| PUT    | `/api/panels/{id}`    | Bearer admin + `PanelIn`                                                             | `PanelOut`; **404** if id missing |
| DELETE | `/api/panels/{id}`    | Bearer admin                                                                         | `204`; **404** if id missing |

`PanelIn`:
```json
{
  "title": "Compressor 1 pressure",
  "source": "device",                   // 'device' | 'tag'
  "device_id": 2, "metric": "pressure", // for source='device'
  "tag_name": "Pressure1",              // for source='tag'
  "window_minutes": 15,                 // 1..1440 — series window
  "chart_type": "timeseries",           // see VALID_CHART_TYPES
  "position": 0,
  "options": { /* per-viz params, e.g. min, max, thresholds, transform */ },
  "poll_interval_seconds": 5            // one of 5, 30, 60, 600, 1800, 3600
}
```

Chart types: `timeseries`, `line`, `bar`, `stat`, `gauge`, `bargauge`, `histogram`, `table`.

Validation rules in `panels._validate`:
- `chart_type ∈ VALID_CHART_TYPES`
- `source ∈ {'device','tag'}`
- `poll_interval_seconds ∈ {5, 30, 60, 600, 1800, 3600}`
- `source='device'` requires `device_id` AND `metric`
- `source='tag'` requires `tag_name` AND `metric ∈ db.tag_fields()` (a discovered numeric column)

### 7.6 Errors

- Bad credentials → `401 {"message": "Invalid username or password"}`.
- Missing/expired/invalid access token → `401 {"detail": "..."}`.
- Missing/invalid refresh cookie on `/refresh` → `401 {"detail": "..."}`.
- Bad/expired/single-use-already-consumed reset token → `400 {"detail": "..."}`.
- Admin-only route accessed by a non-admin → `403 {"detail": "Admin access required"}`.

### 7.7 Tokens

HS256 JWTs. Each carries `sub` (user id), `type` (`access` / `refresh` / `reset`), `iat`, `exp`,
`jti`; access tokens additionally carry `role`. Lifetimes are governed by `ACCESS_EXPIRE_MIN` /
`REFRESH_EXPIRE_DAYS` / `RESET_EXPIRE_MIN`. Revocation lists are **in-memory** (refresh `jti`
denylist, reset `jti` used-set) — they reset on service restart, which is acceptable for the
current single-process deployment.

### 7.8 Smoke test

```powershell
curl -s -X POST http://localhost:8088/api/auth/login `
  -H "Content-Type: application/json" -d '{\"username\":\"admin\",\"password\":\"admin123\"}'
```

---

## 8. Frontend — local development

```powershell
cd C:\dev\scada-frontend
npm install          # first time
npm run dev          # → http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `http://127.0.0.1:8088` (see `vite.config.js`),
so **run the backend first**. Sign in at `http://localhost:5173/login` with `admin` / `admin123`.

Build for production:

```powershell
npm run build        # outputs to dist\ (includes web.config from public\)
```

### Pages

| Route             | Component             | Auth     | Purpose |
|-------------------|-----------------------|----------|---------|
| `/login`          | `LoginPage`           | public   | Sign-in |
| `/reset-password` | `ResetPasswordPage`   | public   | Consumes single-use reset token |
| `/`               | `OverviewPage`        | required | KPI snapshot |
| `/devices`        | `DevicesPage`         | required | Device list / detail |
| `/alarms`         | `AlarmsPage`          | required | Alarm log |
| `/trends`         | `TrendsPage`          | required | Trend chart + embedded Grafana panel |
| `/live`           | `LivePage`            | required | Admin-managed live tile grid (read for operators, edit for admins) |
| `/settings`       | `SettingsPage`        | required | Profile / change-password |
| `/accounts`       | `AccountsPage`        | admin    | User CRUD |

### Live dashboard internals

`LivePage.vue` lists panels from `GET /api/panels` and renders one `LivePanel.vue` per row.
Each `LivePanel`:

- Self-polls at `panel.poll_interval_seconds` (whitelist must match the backend).
- For `source='tag'`, calls `GET /api/tags/latest` for each tag in
  `panel.options.tags ?? [panel.tag_name]` and treats each tag as its own coloured series.
  Colours come from `src/utils/seriesPalette.js`.
- For `source='device'`, seeds the chart with `GET /api/readings/series` and tops it up with
  `GET /api/readings/latest` per poll.
- Renders one of: time series, line, bar, stat, gauge, bar gauge, histogram, table —
  all backed by ECharts via `vue-echarts`.
- Reads `panel.options.transform` (a string like `value/10` or `sqrt(value)`) and runs it
  through `src/utils/mathExpr.js` — a safe recursive-descent evaluator that supports
  `+ - * / ^`, function calls (`abs/sqrt/pow/min/max/floor/ceil/round`) and the identifier
  `value`. There is no `eval`, no `Function`, no DOM access — invalid input is dropped.
- Emits `updated` after every successful poll so `LivePage` can show "Updated h:mm:ss".
- Admins see Edit / Duplicate / Delete; operators get a read-only tile.

### Auth flow (frontend)

**Token storage model:** access tokens live in **module memory** in `src/api/client.js`
(set via `setAccessToken()` / `clearAccessToken()`); the Pinia auth store keeps only a boolean
`_hasToken` so components can reactively check `isLoggedIn`. The refresh token is **never** visible
to JavaScript — it's set by the server as an **HttpOnly cookie** at path `/api/auth`, so XSS
cannot exfiltrate it. Nothing auth-related is in `localStorage`.

Sign-in & session lifecycle:

1. `LoginPage.vue` → `auth.signIn()` (Pinia `src/stores/auth.js`) → `POST /api/auth/login`.
   The response body has the access token; the server sets the refresh cookie via `Set-Cookie`.
2. `src/api/client.js` request interceptor attaches `Authorization: Bearer <access>` to every
   request from its in-memory copy.
3. On a `401`, the response interceptor transparently calls `/api/auth/refresh` once (the browser
   sends the cookie automatically), updates the in-memory access token, and retries — **except**
   for requests whose URL contains `/auth/` (`isAuthCall` skip), so a wrong-password login surfaces
   the real `401 {"message": "Invalid username or password"}` instead of bouncing through refresh.
4. On first navigation after a page reload, `router/index.js` calls `auth.initialize()` which
   silently invokes `/api/auth/refresh` using the cookie. If the cookie is still valid the session
   is restored without a visible login; if not, the user lands on `/login`.
5. `auth.signOut()` calls `POST /api/auth/logout` — the server clears the cookie and adds the
   refresh `jti` to the in-memory denylist.

Public routes (no auth): `/login`, `/reset-password`. Admin-only route: `/accounts`
(`meta.requiresRole: 'admin'` in `router/index.js`; non-admins are redirected to `/`).

> **Security note for prod:** set `COOKIE_SECURE=true` once the site is served over HTTPS, so the
> refresh cookie has the `Secure` flag. Without it, browsers will refuse to send the cookie back
> over plain HTTP — login appears to succeed but `/auth/refresh` fails on reload.

---

## 9. Production deployment

### 9a. Backend as a Windows service (NSSM)

The backend runs under NSSM as service **`mml-api`**. Two paths:

**Path A — one-shot installer (recommended).** From an *Administrator-capable* PowerShell:

```powershell
cd C:\dev\scada-mml-backend
.\install.ps1                       # bind 127.0.0.1:8088 (behind IIS)
.\install.ps1 -BindHost 0.0.0.0     # standalone direct access (no IIS)
.\install.ps1 -Port 9000 -ServiceName mml-api
```

`install.ps1` self-elevates and walks the full setup:

1. Verifies Python is in PATH.
2. Locates `nssm.exe` (vendored, project dir, or PATH).
3. Creates the venv if missing, installs `requirements.txt`.
4. Copies `.env.example` → `.env` on first run and interactively prompts for
   `DB_PASSWORD`, auto-generates a strong `JWT_SECRET` if you accept the default,
   and lets you set `CORS_ORIGINS`.
5. Creates `scada-mml-backend\logs\` for stdout/stderr.
6. Runs `seed_users.py` (idempotent — non-fatal if DB is not reachable yet).
7. Removes any existing `mml-api` service, then registers a new one with:
   - Application: `…\venv\Scripts\python.exe`
   - Arguments: `-m uvicorn main:app --host <BindHost> --port <Port>`
   - AppDirectory: `scada-mml-backend`
   - Stdout/Stderr: `scada-mml-backend\logs\stdout.log` / `stderr.log`
   - `Start=SERVICE_AUTO_START`, daily log rotation, `PYTHONUNBUFFERED=1`
8. Starts the service and hits `GET /health` to confirm.

`uninstall.ps1` stops + removes the service (logs and `.env` are left in place).

**Path B — manual NSSM** (older docs; equivalent result):

| NSSM setting   | Value |
|----------------|-------|
| Application    | `C:\dev\scada-mml-backend\venv\Scripts\python.exe` |
| Arguments      | `-m uvicorn main:app --host 127.0.0.1 --port 8088` |
| AppDirectory   | `C:\dev\scada-mml-backend` |
| AppStdout/Stderr | `C:\inetpub\mml-api\logs\stdout.log` / `stderr.log` |

Binding to `127.0.0.1` is intentional when fronted by IIS — the service is only reached via the reverse proxy.

```powershell
# manage the service (Administrator)
Start-Service mml-api
Restart-Service mml-api
Get-Service mml-api
```

### 9b. Frontend on IIS with reverse proxy

1. Build the SPA: `npm run build` → deploy the contents of `scada-frontend\dist\` to the IIS site's
   physical path.
2. Create an IIS **Site** with that folder as the physical path; app pool can be **No Managed Code**.
3. Install **URL Rewrite** + **ARR**, then **enable the proxy**:
   IIS Manager → server node → *Application Request Routing Cache* → *Server Proxy Settings* →
   tick **Enable proxy** → Apply. *(This single toggle is the most common reason `/api` returns 404.)*
4. Ensure the backend is reachable at `http://127.0.0.1:8088` from the IIS host.

`dist\web.config` already defines the rules:
- `^api/(.*)$`  → `http://127.0.0.1:8088/api/{R:1}`  (REST)
- `^ws(/.*)?$`  → `http://127.0.0.1:8088/ws{R:1}`     (WebSocket — currently unused but reserved)
- SPA fallback → `index.html` for non-file, non-`/api`, non-`/ws` requests (vue-router history mode)
- `httpErrors errorMode="PassThrough"` so backend error bodies reach the client unchanged.

### 9c. Verify the deployment

Run as **Administrator**:

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\verify_prod.ps1
```

It starts the service, tests the backend directly on 8088, enumerates IIS sites/bindings, checks
that ARR proxy is enabled, then logs in through the IIS site and checks SPA fallback. Results are
written to `C:\dev\verify_prod.log`.

---

## 10. Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `install.ps1` says "NSSM not found" | Place `nssm.exe` next to `install.ps1` (the repo already vendors one) or install NSSM on PATH. |
| `install.ps1` health check fails but service is "Running" | DB credentials in `.env` are wrong. Inspect `scada-mml-backend\logs\stderr.log`, then `Restart-Service mml-api` after fixing `.env`. |
| NSSM service "unexpected error to start" | A bare FastAPI app starts no server. Use `-m uvicorn main:app ...` (current config) or `python main.py` (has a `__main__` block). |
| `WinError 10013` binding a port | Port is reserved/blocked (e.g. 8000 on this host) or already in use. Use 8088, or check `netsh interface ipv4 show excludedportrange protocol=tcp`. |
| `/api/...` returns **404** through IIS | ARR proxy not enabled (§9b step 3), or the rewrite rule didn't match. |
| `/api/...` returns **502** through IIS | Backend (`mml-api`) is not running / not listening on 127.0.0.1:8088. |
| `500.52` on every IIS request | A rewrite rule sets a server variable (e.g. `X-Forwarded-*`) that isn't registered in `allowedServerVariables`. See the comment block in `web.config`. |
| `Failed to fetch dynamically imported module …Page.vue` (dev) | Two Vite dev servers fighting over port 5173. Kill stray `node` processes and start one instance. |
| `psql` not found | It's at `C:\Program Files\PostgreSQL\18\bin\psql.exe` (not on PATH by default). |
| Starting/stopping the service fails with "Cannot open … service" | The shell isn't elevated. Run PowerShell **as Administrator**. |
| `/forgot-password` returns OK but no email arrives | Neither `BREVO_API_KEY` nor `SMTP_HOST` is configured → log-only mode. Grep `logs\stdout.log` for `PASSWORD RESET for`. If Brevo is configured but failing, check `stderr.log`. SMTP fallback needs the host's public IP authorized in the provider's allow-list. |
| Edits to `.env` are not picked up | The service reads env at startup. `Restart-Service mml-api` *(admin)*. |
| Reset link says "Invalid or expired" | Reset tokens are **single-use** and expire after `RESET_EXPIRE_MIN` minutes. Request a fresh link. |
| Login works in dev, then "Not authenticated" after page reload in prod | `COOKIE_SECURE=true` requires HTTPS — the browser refuses to send the refresh cookie over plain HTTP. Move the IIS binding to HTTPS, or temporarily set `COOKIE_SECURE=false`. |
| `/accounts` redirects to `/` | The current user is not `role='admin'`. Sign in as `admin`, or `UPDATE users SET role='admin' WHERE username='you';`. |
| New numeric column in `variables_tag` doesn't appear in the panel editor | Fields are discovered once per process. `Restart-Service mml-api` to re-introspect. |
| CORS error in browser console (prod) | Add the prod origin to `CORS_ORIGINS` in `.env` and restart. Wildcards aren't allowed because `allow_credentials=True`. |

---

## 11. Security notes / follow-ups

**Already hardened**

- Refresh token is delivered as an **HttpOnly, SameSite=Strict cookie** at path `/api/auth` (XSS
  can't read it), not stored in `localStorage`.
- Access token lives only in module memory (cleared on logout / refresh failure).
- CORS uses an explicit origin allow-list (`CORS_ORIGINS`), not `"*"` — required for
  `allow_credentials=True`.
- Public self-registration always returns `role='operator'`; admin creation requires an existing
  admin via `/api/users`. Admin-only routes are double-checked client-side (`requiresRole`) and
  server-side (`require_admin`).
- Panel writes (`POST/PUT/DELETE /api/panels`) require an admin token; reads are open to any
  authenticated user.
- `forgot-password` returns a generic response regardless of whether the email exists (no
  enumeration leak); reset tokens are single-use JWTs with their own `jti`/denylist.
- Self-delete and last-admin removal/demotion are blocked server-side in `/api/users`.
- `panel.options.transform` is parsed by a custom recursive-descent evaluator with a fixed
  function whitelist — no `eval`/`Function`/prototype access.

**Outstanding**

- Refresh-token revocation (`logout`) and reset-token consumption are **in-memory only** — they
  reset on service restart and assume a single worker process. Move to Postgres/Redis if you scale
  to multiple workers or need durable revocation.
- Rotate `JWT_SECRET` for production; existing tokens become invalid (intended).
- `.env` holds the DB password and JWT/SMTP/Brevo secrets — keep it out of version control.
- Set `COOKIE_SECURE=true` once the site is served over HTTPS.
- Add rate-limiting on `/auth/login`, `/auth/forgot-password`, and `/auth/reset-password`
  (e.g. `slowapi`) before exposing the service to the public internet.
- Real ingest pipeline: today `sensor_readings` is fed by `simulate_data.py`; replace with a real
  MQTT or PLC bridge for production. `init_db.sql` is a head-start on that schema.
