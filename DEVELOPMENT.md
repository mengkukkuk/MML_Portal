# SCADA Stack — Development Guide

End-to-end developer documentation for the SCADA monitoring system: a FastAPI backend with
JWT auth backed by PostgreSQL, and a Vue 3 + Vite single-page frontend. Covers local
development, the auth system, running as a Windows service (NSSM), and production deployment
behind IIS.

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
                                              │  users table (auth)       │
                                              └──────────────────────────┘

  Planned data path (not yet implemented):
      field devices ──MQTT──▶ mml-api ──▶ PostgreSQL ──▶ Grafana dashboards
```

- **Backend** terminates auth, will later ingest device data over MQTT and write to Postgres.
- **Grafana** (planned) reads Postgres directly for dashboards.
- The previous direct PLC-over-WebSocket integration (`pymcprotocol`) was **removed**.

---

## 2. Tech stack

| Layer    | Technology |
|----------|------------|
| Backend  | Python 3.14, FastAPI 0.136, Uvicorn 0.48, psycopg 3.3 (binary), PyJWT 2.13, python-dotenv |
| Auth     | JWT (HS256) access + refresh tokens; password hashing via stdlib `hashlib.scrypt` |
| Database | PostgreSQL 18 (`postgresql-x64-18`), localhost:5432 |
| Frontend | Vue 3.5, Vite 8, vue-router 5, Pinia 3, axios, Element Plus, ECharts |
| Service  | NSSM (runs uvicorn as a Windows service) |
| Web host | IIS + URL Rewrite + Application Request Routing (ARR) |

> **Why scrypt instead of bcrypt/passlib?** Python 3.14 is bleeding-edge; `bcrypt`/`passlib`
> compiled wheels are unreliable. `hashlib.scrypt` is in the standard library — zero wheel risk.
> `psycopg[binary]` and `PyJWT` both ship cp314 wheels, so they install cleanly.

---

## 3. Repository layout

```
C:\dev\
├── scada-mml-backend\            # FastAPI backend
│   ├── main.py                   # App factory: CORS (explicit origins, credentials=true), mounts auth + users routers, /health, port 8088
│   ├── config.py                 # Loads .env (DB, JWT, account, SMTP, cookie)
│   ├── db.py                     # psycopg 3 access layer (users CRUD + lookups by id/username/email)
│   ├── security.py               # scrypt hashing + JWT create/decode (access/refresh/reset)
│   ├── auth.py                   # /api/auth router: login, register, me, refresh, logout, change-password, forgot-password, reset-password
│   ├── users.py                  # /api/users router: admin CRUD with last-admin guards
│   ├── mailer.py                 # SMTP-or-log password-reset email delivery
│   ├── seed_users.py             # Creates/migrates users table + seeds mock users
│   ├── requirements.txt
│   ├── .env                      # Local secrets (NOT committed)
│   ├── .env.example
│   └── venv\                     # Python 3.14 virtual environment
│
├── scada-frontend\               # Vue 3 + Vite SPA
│   ├── src\
│   │   ├── api\                  # client.js (axios; access-token in module memory), auth.js, users.js, devices.js, alarms.js
│   │   ├── stores\               # Pinia: auth.js, users.js, devices.js, alarms.js, connection.js
│   │   ├── pages\                # LoginPage, ResetPasswordPage (public); Overview, Devices, Alarms, Trends, Settings, AccountsPage (admin), NotFoundPage
│   │   ├── router\index.js       # Routes + requiresAuth + requiresRole guards; auth.initialize() on first navigation
│   │   └── ...
│   ├── public\web.config         # IIS config (copied into dist on build)
│   ├── dist\                     # Production build output (deploy this to IIS)
│   ├── vite.config.js            # Dev proxy /api,/ws → 127.0.0.1:8088
│   └── package.json
│
├── README.md                     # Deployment guide (install / configure / deploy / troubleshoot)
├── DEVELOPMENT.md                # This file — developer reference (architecture, internals)
└── verify_prod.ps1               # Admin script: verifies service + IIS reverse proxy
```

---

## 4. Prerequisites

- **Python 3.14** (backend venv already created at `scada-mml-backend\venv`)
- **Node.js 20+** and npm (frontend)
- **PostgreSQL 18** running on `localhost:5432` (service `postgresql-x64-18`)
- For production: **IIS** with **URL Rewrite 2.x** and **Application Request Routing 3.x**, plus
  the **WebSocket Protocol** feature; **NSSM** for the backend service.

---

## 5. Backend — local development

```powershell
cd C:\dev\scada-mml-backend

# 1. (first time) install dependencies into the venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. configure environment — copy the example and fill DB_PASSWORD
Copy-Item .env.example .env    # then edit .env

# 3. seed the database (creates users table + mock users; idempotent)
.\venv\Scripts\python.exe seed_users.py

# 4. run the API (dev)
.\venv\Scripts\python.exe main.py
#    → http://0.0.0.0:8088   |   Swagger UI: http://localhost:8088/docs
```

`main.py` has an `if __name__ == "__main__"` block that launches uvicorn, so `python main.py`
fully starts the server (important — a bare FastAPI app object does nothing on its own).

### `.env` reference

The full reference (~20 keys, grouped DB / JWT / Account / SMTP / CORS / Cookie) lives in
[`README.md` §4 Configuration](README.md#4-configuration). The bare minimum to start the backend:

| Key                  | Default     | Purpose |
|----------------------|-------------|---------|
| `DB_PASSWORD`        | *(blank)*   | **Required** — Postgres password |
| `JWT_SECRET`         | dev value   | HMAC secret — generate with `python -c "import secrets;print(secrets.token_hex(32))"` |
| `APP_BASE_URL`       | `http://localhost:5173` | Base URL used to build password-reset links in emails |

Optional sections covered in the README: token lifetimes (`ACCESS_EXPIRE_MIN`, `REFRESH_EXPIRE_DAYS`,
`RESET_EXPIRE_MIN`, `MIN_PASSWORD_LEN`), SMTP relay (`SMTP_*` — leave `SMTP_HOST` blank to log the
reset link instead of sending), CORS allow-list (`CORS_ORIGINS`), and the HTTPS-only cookie flag
(`COOKIE_SECURE`).

---

## 6. Database

`seed_users.py` creates the table, applies migrations, and seeds test accounts (idempotent — safe
to re-run; each statement is an `IF NOT EXISTS` or `ON CONFLICT` upsert):

```sql
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- format: scrypt$<salt_hex>$<hash_hex>
  role          TEXT NOT NULL DEFAULT 'operator',
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: optional email column for account management + password reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON users (lower(email)) WHERE email IS NOT NULL;
```

The unique index is **partial** (only enforced where `email IS NOT NULL`) and case-insensitive,
which matches `db.get_user_by_email()`'s `lower(email) = lower(%s)` lookup.

### Mock users (for testing)

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

### 7.3 Errors

- Bad credentials → `401 {"message": "Invalid username or password"}`.
- Missing/expired/invalid access token → `401 {"detail": "..."}`.
- Missing/invalid refresh cookie on `/refresh` → `401 {"detail": "..."}`.
- Bad/expired/single-use-already-consumed reset token → `400 {"detail": "..."}`.
- Admin-only route accessed by a non-admin → `403 {"detail": "Admin access required"}`.

### 7.4 Tokens

HS256 JWTs. Each carries `sub` (user id), `type` (`access` / `refresh` / `reset`), `iat`, `exp`,
`jti`; access tokens additionally carry `role`. Lifetimes are governed by `ACCESS_EXPIRE_MIN` /
`REFRESH_EXPIRE_DAYS` / `RESET_EXPIRE_MIN`. Revocation lists are **in-memory** (refresh `jti`
denylist, reset `jti` used-set) — they reset on service restart, which is acceptable for the
current single-process deployment.

### 7.5 Smoke test

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

### Auth flow (frontend)

**Token storage model (changed):** access tokens live in **module memory** in `src/api/client.js`
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
(`meta.requiresRole: 'admin'` in `router/index.js`; non-admins are redirected to `/overview`).

> **Security note for prod:** set `COOKIE_SECURE=true` once the site is served over HTTPS, so the
> refresh cookie has the `Secure` flag. Without it, browsers will refuse to send the cookie back
> over plain HTTP — login appears to succeed but `/auth/refresh` fails on reload.

---

## 9. Production deployment

### 9a. Backend as a Windows service (NSSM)

The backend runs under NSSM as service **`mml-api`**:

| NSSM setting   | Value |
|----------------|-------|
| Application    | `C:\dev\scada-mml-backend\venv\Scripts\python.exe` |
| Arguments      | `-m uvicorn main:app --host 127.0.0.1 --port 8088` |
| AppDirectory   | `C:\dev\scada-mml-backend` |
| AppStdout/Stderr | `C:\inetpub\mml-api\logs\stdout.log` / `stderr.log` |

Binding to `127.0.0.1` is intentional — the service is only reached via the IIS reverse proxy.

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
- `^ws(/.*)?$`  → `http://127.0.0.1:8088/ws{R:1}`     (WebSocket)
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
| NSSM service "unexpected error to start" | A bare FastAPI app starts no server. Use `-m uvicorn main:app ...` (current config) or `python main.py` (has a `__main__` block). |
| `WinError 10013` binding a port | Port is reserved/blocked (e.g. 8000 on this host) or already in use. Use 8088, or check `netsh interface ipv4 show excludedportrange protocol=tcp`. |
| `/api/...` returns **404** through IIS | ARR proxy not enabled (§9b step 3), or the rewrite rule didn't match. |
| `/api/...` returns **502** through IIS | Backend (`mml-api`) is not running / not listening on 127.0.0.1:8088. |
| `500.52` on every IIS request | A rewrite rule sets a server variable (e.g. `X-Forwarded-*`) that isn't registered in `allowedServerVariables`. See the comment block in `web.config`. |
| `Failed to fetch dynamically imported module …Page.vue` (dev) | Two Vite dev servers fighting over port 5173. Kill stray `node` processes and start one instance. |
| `psql` not found | It's at `C:\Program Files\PostgreSQL\18\bin\psql.exe` (not on PATH by default). |
| Starting/stopping the service fails with "Cannot open … service" | The shell isn't elevated. Run PowerShell **as Administrator**. |
| `/forgot-password` returns OK but no email arrives | `SMTP_HOST` is blank → the link is **logged**, not sent. Grep `C:\inetpub\mml-api\logs\stdout.log` for `PASSWORD RESET for`. If SMTP is configured, look for `Failed to send password-reset email` in stderr. With Brevo, the host's public IP must be **authorized** in your Brevo SMTP settings. |
| Edits to `.env` are not picked up | The service reads env at startup. `Restart-Service mml-api` *(admin)*. |
| Reset link says "Invalid or expired" | Reset tokens are **single-use** and expire after `RESET_EXPIRE_MIN` minutes. Request a fresh link. |
| Login works in dev, then "Not authenticated" after page reload in prod | `COOKIE_SECURE=true` requires HTTPS — the browser refuses to send the refresh cookie over plain HTTP. Move the IIS binding to HTTPS, or temporarily set `COOKIE_SECURE=false`. |
| `/accounts` redirects to `/overview` | The current user is not `role='admin'`. Sign in as `admin`, or `UPDATE users SET role='admin' WHERE username='you';`. |
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
- `forgot-password` returns a generic response regardless of whether the email exists (no
  enumeration leak); reset tokens are single-use JWTs with their own `jti`/denylist.
- Self-delete and last-admin removal/demotion are blocked server-side in `/api/users`.

**Outstanding**

- Refresh-token revocation (`logout`) and reset-token consumption are **in-memory only** — they
  reset on service restart and assume a single worker process. Move to Postgres/Redis if you scale
  to multiple workers or need durable revocation.
- Rotate `JWT_SECRET` for production; existing tokens become invalid (intended).
- `.env` holds the DB password and JWT/SMTP secrets — keep it out of version control.
- Set `COOKIE_SECURE=true` once the site is served over HTTPS.
- Add rate-limiting on `/auth/login`, `/auth/forgot-password`, and `/auth/reset-password`
  (e.g. `slowapi`) before exposing the service to the public internet.

**Next milestone:** MQTT ingest → Postgres writer endpoints on the same FastAPI app, then Grafana
dashboards reading Postgres directly.
