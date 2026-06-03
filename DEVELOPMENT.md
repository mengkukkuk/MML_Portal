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
        │   IIS site (prod)       │  /api/* │  scada-api (FastAPI)      │
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
      field devices ──MQTT──▶ scada-api ──▶ PostgreSQL ──▶ Grafana dashboards
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
│   ├── main.py                   # App factory: mounts auth router, /health, port 8088
│   ├── config.py                 # Loads .env (DB + JWT settings)
│   ├── db.py                     # psycopg 3 access layer (get_user_by_username/id)
│   ├── security.py               # scrypt hashing + JWT create/decode
│   ├── auth.py                   # /api/auth router (login, me, refresh, logout)
│   ├── seed_users.py             # Creates users table + seeds mock users
│   ├── requirements.txt
│   ├── .env                      # Local secrets (NOT committed)
│   ├── .env.example
│   └── venv\                     # Python 3.14 virtual environment
│
├── scada-frontend\               # Vue 3 + Vite SPA
│   ├── src\
│   │   ├── api\                  # client.js (axios+interceptors), auth.js, devices.js, alarms.js
│   │   ├── stores\               # Pinia: auth.js, devices.js, alarms.js, connection.js
│   │   ├── pages\                # LoginPage.vue, OverviewPage.vue, ...
│   │   ├── router\index.js       # Routes + requiresAuth guard
│   │   └── ...
│   ├── public\web.config         # IIS config (copied into dist on build)
│   ├── dist\                     # Production build output (deploy this to IIS)
│   ├── vite.config.js            # Dev proxy /api,/ws → 127.0.0.1:8088
│   └── package.json
│
├── DEVELOPMENT.md                # This file
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

| Key                  | Default     | Purpose |
|----------------------|-------------|---------|
| `DB_HOST`            | `localhost` | Postgres host |
| `DB_PORT`            | `5432`      | Postgres port |
| `DB_NAME`            | `postgres`  | Database name |
| `DB_USER`            | `postgres`  | Database user |
| `DB_PASSWORD`        | *(blank)*   | **Required** — Postgres password |
| `JWT_SECRET`         | dev value   | HMAC secret — generate with `python -c "import secrets;print(secrets.token_hex(32))"` |
| `ACCESS_EXPIRE_MIN`  | `30`        | Access-token lifetime (minutes) |
| `REFRESH_EXPIRE_DAYS`| `7`         | Refresh-token lifetime (days) |

---

## 6. Database

`seed_users.py` creates the table and seeds test accounts (idempotent — safe to re-run):

```sql
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- format: scrypt$<salt_hex>$<hash_hex>
  role          TEXT NOT NULL DEFAULT 'operator',
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Mock users (for testing)

| Username   | Password      | Role      | Display name   |
|------------|---------------|-----------|----------------|
| `admin`    | `admin123`    | `admin`   | Administrator  |
| `operator` | `operator123` | `operator`| Line Operator  |

Inspect from a shell:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -h localhost `
  -c "SELECT id, username, role, display_name FROM users ORDER BY id;"
```

To add a user programmatically, hash with `security.hash_password()` and insert; or add an entry
to `MOCK_USERS` in `seed_users.py` and re-run it.

---

## 7. Auth API reference

Base path: **`/api/auth`** (all JSON). Access tokens are sent as `Authorization: Bearer <token>`.

| Method | Path                | Body                       | Success response |
|--------|---------------------|----------------------------|------------------|
| POST   | `/api/auth/login`   | `{username, password}`     | `{access_token, refresh_token, expires_in, user:{id,username,role,display_name}}` |
| GET    | `/api/auth/me`      | — (Bearer)                 | `{id, username, role, display_name}` |
| POST   | `/api/auth/refresh` | `{refresh_token}`          | `{access_token, expires_in}` |
| POST   | `/api/auth/logout`  | `{refresh_token}`          | `204 No Content` |

**Errors:**
- Bad credentials → `401 {"message": "Invalid username or password"}` (the frontend reads
  `error.response.data.message`).
- Missing/expired/invalid token → `401 {"detail": "..."}`.

**Tokens:** HS256 JWTs. Access token carries `sub` (user id), `role`, `type:"access"`, `exp`,
`jti`. Refresh token carries `sub`, `type:"refresh"`, `exp`, `jti`. `logout` adds the refresh
token's `jti` to an **in-memory** denylist (resets on restart — acceptable for current scope; use
a persistent store if you need durable revocation).

Quick smoke test:

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

1. `LoginPage.vue` → `auth.signIn()` (Pinia store `src/stores/auth.js`) → `POST /api/auth/login`.
2. Access + refresh tokens saved to `localStorage` (`scada_token`, `scada_refresh`).
3. `src/api/client.js` axios interceptor attaches `Authorization: Bearer` to every request and,
   on a `401`, transparently calls `/api/auth/refresh` once and retries.
4. `router/index.js` `beforeEach` guard enforces `meta.requiresAuth`; if a token exists but the
   user object isn't loaded it calls `/api/auth/me`.

> **Known caveat:** the 401 interceptor fires on **any** 401, including `/api/auth/login`. A
> wrong-password attempt therefore triggers a refresh that fails and hard-redirects to `/login`,
> showing a generic "Login failed" instead of the server message. Optional one-line fix in
> `src/api/client.js` (the 401 condition): add `&& !original.url?.includes('/auth/')`. The
> happy-path login is unaffected.

---

## 9. Production deployment

### 9a. Backend as a Windows service (NSSM)

The backend runs under NSSM as service **`scada-api`**:

| NSSM setting   | Value |
|----------------|-------|
| Application    | `C:\dev\scada-mml-backend\venv\Scripts\python.exe` |
| Arguments      | `-m uvicorn main:app --host 127.0.0.1 --port 8088` |
| AppDirectory   | `C:\dev\scada-mml-backend` |
| AppStdout/Stderr | `C:\inetpub\scada-api\logs\stdout.log` / `stderr.log` |

Binding to `127.0.0.1` is intentional — the service is only reached via the IIS reverse proxy.

```powershell
# manage the service (Administrator)
Start-Service scada-api
Restart-Service scada-api
Get-Service scada-api
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
| `/api/...` returns **502** through IIS | Backend (`scada-api`) is not running / not listening on 127.0.0.1:8088. |
| `500.52` on every IIS request | A rewrite rule sets a server variable (e.g. `X-Forwarded-*`) that isn't registered in `allowedServerVariables`. See the comment block in `web.config`. |
| `Failed to fetch dynamically imported module …Page.vue` (dev) | Two Vite dev servers fighting over port 5173. Kill stray `node` processes and start one instance. |
| `psql` not found | It's at `C:\Program Files\PostgreSQL\18\bin\psql.exe` (not on PATH by default). |
| Starting/stopping the service fails with "Cannot open … service" | The shell isn't elevated. Run PowerShell **as Administrator**. |

---

## 11. Security notes / follow-ups

- `CORSMiddleware` is currently `allow_origins=["*"]` — fine for a LAN tool, tighten for exposure.
- Refresh-token revocation (`logout`) is in-memory only; move to Postgres/Redis for durability.
- `.env` holds the DB password and JWT secret — keep it out of version control; rotate `JWT_SECRET`
  for production.
- Optional frontend interceptor fix for wrong-password UX (see §8).
- Next milestone: MQTT ingest → Postgres writer endpoints on the same FastAPI app, then Grafana
  dashboards reading Postgres.
