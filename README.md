# MMLPortal — SCADA Stack Deployment Guide

FastAPI backend + Vue 3 SPA, JWT auth backed by PostgreSQL, deployed on Windows behind IIS.
This file is the **deployment-focused** guide; deeper internals live in
[`DEVELOPMENT.md`](DEVELOPMENT.md). An interactive system workflow ships at
[`workflow.html`](workflow.html) — open it in any browser.

---

## 1. Project structure

```
C:\dev\
├── README.md                       ← this file
├── DEVELOPMENT.md                  ← architecture & developer reference
├── workflow.html                   ← interactive end-to-end system workflow
├── verify_prod.ps1                 ← admin script: verifies service + IIS proxy
│
├── scada-mml-backend\              ← FastAPI service (Python 3.14)
│   ├── main.py                     ← app factory: CORS, /health, mounts routers,
│   │                                 init_panels_table() on startup, runs on :8088
│   ├── config.py                   ← reads .env (DB, JWT, account, Brevo, SMTP, cookie)
│   ├── db.py                       ← psycopg 3 access layer (users + readings + tags + panels)
│   ├── security.py                 ← scrypt hashing + JWT (access/refresh/reset)
│   ├── auth.py                     ← /api/auth router (login, register, me, refresh,
│   │                                 logout, change-password, forgot-password, reset-password)
│   ├── users.py                    ← /api/users router (admin user CRUD, require_admin)
│   ├── readings.py                 ← /api/readings router (sensor_readings: devices, metrics,
│   │                                 latest, sliding-window series)
│   ├── tags.py                     ← /api/tags router (public.status_tag: names, dynamic numeric
│   │                                 fields, latest row)
│   ├── panels.py                   ← /api/panels router (Live dashboard CRUD; writes need admin)
│   ├── mailer.py                   ← Brevo HTTP API → SMTP fallback → log-only delivery
│   ├── seed_users.py               ← idempotent migration + mock-user seed
│   ├── simulate_data.py            ← writes synthetic sensor_readings (5s tick, optional 2h seed)
│   ├── install.ps1 / install.bat   ← one-shot interactive installer (self-elevates)
│   ├── uninstall.ps1 / .bat        ← stop + remove the NSSM service
│   ├── nssm.exe                    ← vendored NSSM binary
│   ├── init_db.sql                 ← aspirational multi-schema reference (not loaded today)
│   ├── tests\                      ← pytest suite
│   ├── requirements.txt
│   ├── .env.example                ← copy to .env and fill DB_PASSWORD + JWT_SECRET (+ Brevo/SMTP)
│   ├── .env                        ← LOCAL SECRETS — do NOT commit
│   ├── logs\                       ← NSSM stdout/stderr (installer creates this)
│   └── venv\                       ← Python 3.14 virtual environment (created by installer)
│
└── scada-frontend\                 ← Vue 3 + Vite SPA
    ├── package.json                ← vue 3.5, vue-router 5, pinia 3, axios, element-plus, echarts
    ├── vite.config.js              ← dev proxy /api,/ws → 127.0.0.1:8088
    ├── public\
    │   └── web.config              ← IIS rewrite rules (copied into dist on build)
    ├── src\
    │   ├── api\                    ← client.js (axios + auth interceptor), auth.js, users.js,
    │   │                             devices.js, alarms.js, readings.js, tags.js, panels.js
    │   ├── stores\                 ← Pinia: auth, users, devices, alarms, connection
    │   ├── pages\                  ← LoginPage, ResetPasswordPage (public),
    │   │                             OverviewPage, DevicesPage, AlarmsPage, TrendsPage,
    │   │                             LivePage, SettingsPage, AccountsPage (admin-only),
    │   │                             NotFoundPage
    │   ├── components\             ← AppHeader, AppSidebar, ConnectionPill, GaugeTile,
    │   │                             StatCard, TrendChart, GrafanaPanel, LivePanel
    │   ├── utils\                  ← mathExpr.js (safe transform evaluator),
    │   │                             seriesPalette.js (deterministic colour pick)
    │   ├── layouts\AppShell.vue
    │   └── router\index.js         ← routes + requiresAuth / requiresRole guards
    └── dist\                       ← PRODUCTION BUILD OUTPUT (deploy this to IIS)
```

`dist\` is the artifact deployed to IIS; everything else under `scada-frontend\` is source.

---

## 2. Required stacks

| Component | Version / Edition | Why it's needed |
|---|---|---|
| **Python** | 3.14.x | Runs the FastAPI backend |
| **Node.js + npm** | Node 20+ / npm 10+ | Builds the Vue SPA |
| **PostgreSQL** | 18 (`postgresql-x64-18` Windows service) | Stores users, dashboard panels, `sensor_readings`, `status_tag` |
| **NSSM** | any recent build (`nssm.exe` is vendored at `scada-mml-backend\nssm.exe`) | Runs uvicorn as a Windows service `mml-api` |
| **IIS** | 10+ on Windows Server / Windows 11 Pro | Serves the SPA and reverse-proxies `/api` and `/ws` |
| **IIS — URL Rewrite Module** | 2.x | Required by the `<rewrite>` rules in `web.config` |
| **IIS — Application Request Routing (ARR)** | 3.x | Performs the actual reverse-proxy forwarding to `127.0.0.1:8088` |
| **IIS — WebSocket Protocol feature** | Server Manager → Roles → Web Server → WebSocket Protocol | Lets ARR proxy WebSocket upgrades for `/ws` |
| **Brevo API key** *(recommended)* | any v3 key (`xkeysib-…`) | Password-reset HTTP delivery — **no IP allow-list required** |
| **SMTP relay** *(optional fallback)* | any | Legacy fallback used only when `BREVO_API_KEY` is empty |

`psql` lives at `C:\Program Files\PostgreSQL\18\bin\psql.exe` (not on PATH by default).

---

## 3. Installation — step by step

Open an **elevated PowerShell** for steps that touch services / IIS. Steps marked *(admin)* require it.

### 3.1 Get the source

Place (or clone) both projects under `C:\dev`:

```
C:\dev\scada-mml-backend\
C:\dev\scada-frontend\
```

### 3.2 Database — confirm Postgres running

```powershell
Get-Service postgresql-x64-18    # should be Running
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -h localhost -c "SELECT version();"
```

### 3.3 Backend — one-shot installer (recommended) — *(admin)*

The installer self-elevates, so right-click → **Run as Administrator** isn't required from a normal shell:

```powershell
cd C:\dev\scada-mml-backend
.\install.ps1                       # default: bind 127.0.0.1:8088 (behind IIS)
# or
.\install.ps1 -BindHost 0.0.0.0     # standalone direct access (no IIS)
.\install.ps1 -Port 9000 -ServiceName mml-api
```

What it does:

1. Checks Python is in PATH.
2. Locates `nssm.exe` (vendored, project dir, or PATH).
3. Creates `venv\` if missing, installs `requirements.txt`.
4. On first run, copies `.env.example` → `.env` and **interactively** prompts for:
   - `DB_PASSWORD` (Postgres password — required, no default)
   - `JWT_SECRET` (Enter = auto-generate `secrets.token_hex(32)`)
   - `CORS_ORIGINS` (default `http://localhost:5173`)
5. Creates `scada-mml-backend\logs\` for NSSM stdout/stderr.
6. Runs `seed_users.py` (idempotent, non-fatal if DB isn't reachable yet).
7. Removes any existing `mml-api` service, registers a new one (auto-start, daily log rotation).
8. Starts the service and hits `GET /health` to confirm.

After the installer finishes, log files are at `scada-mml-backend\logs\stdout.log` and `stderr.log`.

To remove the service later (logs and `.env` are left in place):

```powershell
cd C:\dev\scada-mml-backend
.\uninstall.ps1
```

### 3.4 Backend — manual install (alternative) — *(admin)*

If you'd rather not use `install.ps1`:

```powershell
cd C:\dev\scada-mml-backend
py -3.14 -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip
.\venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env         # then edit .env (set DB_PASSWORD + JWT_SECRET)
.\venv\Scripts\python.exe seed_users.py

# Register the NSSM service by hand
nssm install mml-api `
  "C:\dev\scada-mml-backend\venv\Scripts\python.exe" `
  "-m uvicorn main:app --host 127.0.0.1 --port 8088"
nssm set mml-api AppDirectory "C:\dev\scada-mml-backend"
nssm set mml-api AppStdout    "C:\dev\scada-mml-backend\logs\stdout.log"
nssm set mml-api AppStderr    "C:\dev\scada-mml-backend\logs\stderr.log"
New-Item -Force -ItemType Directory C:\dev\scada-mml-backend\logs | Out-Null
Start-Service mml-api
```

Binding to `127.0.0.1` is intentional behind IIS — the service is only reached via the reverse proxy.
Verify: `curl http://127.0.0.1:8088/health` → `{"status":"ok"}` and Swagger at
`http://127.0.0.1:8088/docs`.

### 3.5 (Optional) Keep the demo data flowing

The Live and Trends pages read `public.sensor_readings`. In dev, generate fake data with the
simulator:

```powershell
cd C:\dev\scada-mml-backend
.\venv\Scripts\python.exe simulate_data.py            # forever, 5s tick
.\venv\Scripts\python.exe simulate_data.py --seed     # seed ~2h of history first, then run live
```

In production this is replaced by your real ingest pipeline; the SCADA system writes
`public.status_tag` directly and the API only reads it.

### 3.6 Frontend — build for production

```powershell
cd C:\dev\scada-frontend
npm install
npm run build           # writes scada-frontend\dist\ (includes web.config)
```

For local dev instead: `npm run dev` → `http://localhost:5173` (the dev server proxies
`/api` and `/ws` to `127.0.0.1:8088`).

### 3.7 IIS site + reverse proxy — *(admin)*

1. Install **URL Rewrite 2.x** and **Application Request Routing 3.x** (Web Platform Installer or
   standalone MSIs).
2. Add the **WebSocket Protocol** feature: *Server Manager → Add Roles and Features → Web Server →
   WebSocket Protocol* (or `Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebSockets`).
3. **Enable ARR proxy at server level** *(easy to miss)*: IIS Manager → server node →
   *Application Request Routing Cache* → *Server Proxy Settings* → tick **Enable proxy** → Apply.
4. Create an IIS **Site** whose physical path is `C:\dev\scada-frontend\dist`. App pool can be
   **No Managed Code**. Add a binding (e.g. http\:80, or https with a certificate).

The deployed `web.config` (already in `dist\`) does the rewriting:

| Rule | Match | Action |
|---|---|---|
| Proxy `/ws` | `^ws(/.*)?$` | `http://127.0.0.1:8088/ws{R:1}` (ARR auto-detects upgrade) |
| Proxy `/api` | `^api/(.*)$` | `http://127.0.0.1:8088/api/{R:1}` |
| SPA fallback | non-file, non-`/api`, non-`/ws` | rewrite to `index.html` (vue-router history mode) |

It also passes through backend errors (`httpErrors errorMode="PassThrough"`) so the SPA sees real
`401` / `400` bodies, and disables caching on `index.html`.

### 3.8 Verify *(admin)*

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\verify_prod.ps1
```

Output goes to **`C:\dev\verify_prod.log`**. All sections should show `PASS`. See [§5.3](#53-production-verification).

---

## 4. Configuration

All backend settings come from `C:\dev\scada-mml-backend\.env`. Defaults below are what the code
falls back to when a variable is unset; example values are illustrative.

### 4.1 Database

| Key | Default | Example | Purpose |
|---|---|---|---|
| `DB_HOST` | `localhost` | `localhost` | Postgres host |
| `DB_PORT` | `5432` | `5432` | Postgres port |
| `DB_NAME` | `postgres` | `postgres` | Database name |
| `DB_USER` | `postgres` | `postgres` | Database user |
| `DB_PASSWORD` | *(empty)* | `P@ssw0rd` | **Required** — Postgres password |

### 4.2 JWT

| Key | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | `dev-insecure-change-me` | HMAC signing key. **Rotate for prod.** Generate with `python -c "import secrets;print(secrets.token_hex(32))"`. |
| `ACCESS_EXPIRE_MIN` | `30` | Access-token lifetime (minutes) |
| `REFRESH_EXPIRE_DAYS` | `7` | Refresh-token lifetime (days). Stored as `HttpOnly` cookie. |
| `RESET_EXPIRE_MIN` | `30` | Password-reset-token lifetime (minutes) |

### 4.3 Account management

| Key | Default | Purpose |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:5173` | Base URL the frontend is served from. Reset-link emails are built as `${APP_BASE_URL}/reset-password?token=…`. **Set this to your real prod URL.** |
| `MIN_PASSWORD_LEN` | `8` | Minimum password length (enforced on register, change-password, reset-password, and admin create-user) |

### 4.4 Password-reset email delivery

`mailer.py` picks the first configured path, in this order:

| Priority | Activated when | Notes |
|---|---|---|
| 1. **Brevo HTTP API** *(recommended)* | `BREVO_API_KEY` is set | No IP allow-list required — survives dynamic ISP IPs. Get a key at *Brevo dashboard → SMTP & API → API Keys*. Token format `xkeysib-…`. |
| 2. **SMTP relay** *(legacy fallback)* | `BREVO_API_KEY` empty AND `SMTP_HOST` set | Standard SMTP. Brevo's SMTP path requires authorizing the host's public IP. |
| 3. **Dev console / log-only** | both empty | Reset link is **logged** to `logs\stdout.log`. Useful for dev / air-gapped environments. |

| Key | Default | Example | Purpose |
|---|---|---|---|
| `BREVO_API_KEY` | *(empty)* | `xkeysib-aaa...zzz` | **Preferred** — Brevo v3 API key for HTTP send |
| `SMTP_HOST` | *(empty)* | `smtp-relay.brevo.com` | SMTP relay hostname (fallback only) |
| `SMTP_PORT` | `587` | `587` (STARTTLS) / `465` (SSL) | SMTP server port |
| `SMTP_USER` | *(empty)* | `ad6e01001@smtp-brevo.com` | SMTP auth username |
| `SMTP_PASS` | *(empty)* | `bskFpl3Jl0dutjj` | SMTP password |
| `SMTP_FROM` | *(falls back to `SMTP_USER`)* | `"MMLPortal <no-reply@yourdomain.com>"` | `From:` header. Quoted display name is fine. |
| `SMTP_SECURITY` | `starttls` | `starttls` / `ssl` / `none` | Connection security |
| `SMTP_TIMEOUT` | `10` | `10` | Socket timeout (seconds) |

**Worked example — Brevo HTTP (recommended):**

```env
BREVO_API_KEY=xkeysib-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SMTP_FROM="MMLPortal <no-reply@yourdomain.com>"
```

**Worked example — Brevo SMTP fallback:**

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=ad6e01001@smtp-brevo.com
SMTP_PASS=bskFpl3Jl0dutjj
SMTP_FROM="MMLPortal <no-reply@smtp-brevo.com>"
SMTP_SECURITY=starttls
```

After editing `.env`, **restart the service** so the new vars are loaded:
`Restart-Service mml-api` *(admin)*.

### 4.5 CORS + cookie security (read by `main.py` / `auth.py`)

| Key | Default | Purpose |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list of allowed browser origins. **Must include your production URL** (e.g. `https://scada.example.local`) once deployed — wildcards are not allowed because `allow_credentials=True`. |
| `COOKIE_SECURE` | `false` | When `true`, the refresh-token cookie has `Secure` set (HTTPS only). **Set to `true` in production behind HTTPS.** |

---

## 5. Deployment

### 5.1 Local development

Two (or three) terminals:

```powershell
# Terminal 1 — backend
cd C:\dev\scada-mml-backend
.\venv\Scripts\python.exe main.py       # uvicorn on 0.0.0.0:8088

# Terminal 2 — frontend
cd C:\dev\scada-frontend
npm run dev                              # vite on http://localhost:5173

# Terminal 3 (optional) — fake data so /live and /trends have something to plot
cd C:\dev\scada-mml-backend
.\venv\Scripts\python.exe simulate_data.py --seed
```

Open `http://localhost:5173/login` and sign in with `admin` / `admin123`. Swagger:
`http://localhost:8088/docs`.

### 5.2 Production — single Windows host (NSSM + IIS)

The flow is exactly steps 3.3 and 3.7 above. After both are in place:

1. `Get-Service mml-api` → **Running**.
2. The IIS site responds at its binding URL (e.g. `https://scada.example.local`).
3. Open the binding URL in a browser → login page renders, sign-in works.

To pick up backend code or `.env` changes: `Restart-Service mml-api` *(admin)*.
To redeploy the frontend: `npm run build` then copy `scada-frontend\dist\*` to the IIS site folder.

### 5.3 Production verification

[`C:\dev\verify_prod.ps1`](verify_prod.ps1) runs the full deployment smoke test (must be elevated):

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\verify_prod.ps1
type C:\dev\verify_prod.log
```

It checks, in order:

1. NSSM service is **Running** and something is listening on `127.0.0.1:8088`.
2. Direct backend login: `POST http://127.0.0.1:8088/api/auth/login` returns a token.
3. Enumerates **every IIS site**, prints bindings + physical paths, and identifies the one whose
   path contains `scada-frontend`.
4. **ARR proxy enabled** (reads `applicationHost.config`).
5. Login **through the IIS proxy** at the site's URL.
6. **SPA fallback** — `GET <site>/login` returns the `index.html` shell.

All sections should print `PASS` / a non-empty payload. If §4 reports the proxy disabled, re-do
step 3.7 above.

---

## 6. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| **`install.ps1` says NSSM not found** | The repo vendors `nssm.exe` next to `install.ps1` — make sure it wasn't deleted. Otherwise install NSSM and add to PATH, or drop `nssm.exe` into `scada-mml-backend\`. |
| **`install.ps1` finishes but health check fails** | Service is registered but DB credentials in `.env` are wrong. Check `scada-mml-backend\logs\stderr.log`, fix `.env`, then `Restart-Service mml-api`. |
| **NSSM "unexpected error" starting `mml-api`** | A bare `python` of `main.py` works because of the `__main__` block, but the canonical config uses `-m uvicorn main:app --host 127.0.0.1 --port 8088`. Check `logs\stderr.log` for the actual traceback. |
| **`WinError 10013` binding 8088** | Another process holds 8088, or it's in a Windows reserved range. Check with `Get-NetTCPConnection -LocalPort 8088`. The Vite dev proxy and `web.config` both hard-code 8088. |
| **`/api/*` returns `404` through IIS** | ARR proxy not enabled at the server level. See step 3.7.3 — the single toggle that fixes most prod proxy issues. |
| **`/api/*` returns `502` through IIS** | Backend isn't running or not bound to `127.0.0.1:8088`. `Get-Service mml-api`; check `logs\stderr.log`. |
| **`500.52` on every IIS request** | A rewrite rule sets a server variable (e.g. `X-Forwarded-*`) that wasn't registered in `allowedServerVariables`. Comment block at the top of `dist\web.config` shows the `appcmd` invocation. |
| **Forgot-password says "if that email is registered…" but no email arrives** | Neither `BREVO_API_KEY` nor `SMTP_HOST` is set → *log-only mode*. Grep `logs\stdout.log` for `PASSWORD RESET for`. If Brevo HTTP is configured but failing, look for `Failed to send password-reset email` in `stderr.log` (bad API key, network egress). With Brevo's SMTP path, the host's public IP must be authorized in your Brevo settings. |
| **Edits to `.env` (e.g. SMTP creds) appear ignored** | The service caches env at startup. `Restart-Service mml-api` *(admin)*. |
| **`Restart-Service` says "Cannot open mml-api service"** | The shell isn't elevated. Open PowerShell *as Administrator*. |
| **Reset link says "Invalid or expired"** | Reset tokens are **single-use** and expire after `RESET_EXPIRE_MIN` minutes. Request a fresh one. (The reset endpoints intentionally return **400**, not 401, so the public reset page shows the real message instead of being bounced to `/login` by the axios interceptor.) |
| **Login OK in dev, then "Not authenticated" after page reload in prod** | `COOKIE_SECURE=true` requires HTTPS for the refresh-cookie to be sent. Either switch the IIS binding to HTTPS or set `COOKIE_SECURE=false` (dev only). |
| **CORS error in the browser console (prod)** | Add your prod origin to `CORS_ORIGINS` in `.env` and restart. Wildcards aren't allowed because `allow_credentials=True`. |
| **`/accounts` page redirects to `/`** | The current user isn't `role='admin'`. Sign in as `admin`, or promote a user via `UPDATE users SET role='admin' WHERE username='you'`. |
| **New numeric column on `public.status_tag` doesn't show up in the panel editor** | Fields are introspected once per process and cached. `Restart-Service mml-api` to re-discover. |
| **`Failed to fetch dynamically imported module …Page.vue` in dev** | Two Vite servers are fighting over port 5173. Kill stray `node` processes (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where CommandLine -like '*vite*' \| Stop-Process -Force`). |
| **`psql` not found** | Add `C:\Program Files\PostgreSQL\18\bin` to PATH, or call the full path. |

For architecture, code internals, the full API reference, and the dynamic `status_tag` introspection,
see [`DEVELOPMENT.md`](DEVELOPMENT.md). For a click-through end-to-end visualization,
open [`workflow.html`](workflow.html).
