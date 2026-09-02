# MMLPortal — SCADA Stack Deployment Guide

FastAPI backend + React 19 SPA, JWT auth backed by PostgreSQL, deployed on Windows behind IIS.
This file is the **deployment-focused** guide; deeper internals live in
[`MML_DEVELOPMENT.md`](MML_DEVELOPMENT.md). An interactive system workflow ships at
[`workflow.html`](workflow.html) — open it in any browser.

---

## 1. Project structure

```
C:\dev\
├── README.md                       ← this file
├── MML_DEVELOPMENT.md              ← architecture & developer reference
├── workflow.html                   ← interactive end-to-end system workflow
├── verify_prod.ps1                 ← admin script: verifies service + IIS proxy
│
├── scada-mml-backend\              ← FastAPI service (Python 3.14)
│   ├── main.py                     ← app factory: CORS, /health, mounts routers,
│   │                                 init_*_table() on startup, runs on :8088
│   ├── config.py                   ← reads .env (DB, JWT, account, Brevo, SMTP, cookie)
│   ├── db.py                       ← psycopg 3 access layer (users + readings + tags + panels +
│   │                                 dashboards + datasources + mimic + reports)
│   ├── security.py                 ← scrypt hashing + JWT (access/refresh/reset) + Fernet
│   │                                 encrypt/decrypt for saved datasource passwords
│   ├── auth.py                     ← /api/auth router (login, register, me, refresh,
│   │                                 logout, change-password, forgot-password, reset-password)
│   ├── users.py                    ← /api/users router (admin user CRUD, require_admin)
│   ├── readings.py                 ← /api/readings router (sensor_readings: devices, metrics,
│   │                                 latest, sliding-window series)
│   ├── tags.py                     ← /api/tags router (public.variables_tag: names, dynamic numeric
│   │                                 fields, latest row)
│   ├── schema.py                   ← /api/schema router (generic table/column introspection)
│   ├── panels.py                   ← /api/panels router (Live dashboard CRUD; writes need admin)
│   ├── dashboards.py               ← /api/dashboards router (multi-board Live grid metadata)
│   ├── datasources.py              ← /api/datasources router (saved PostgreSQL connections)
│   ├── mimic.py                    ← /api/mimic router (SCADA mimic layout + symbols)
│   ├── events.py                   ← /api/events router (read-only event log aggregation)
│   ├── alarms.py                   ← /api/alarms router (read-only alarm logs + acknowledgement)
│   ├── reports.py                  ← /api/reports router (OEE / production reporting)
│   ├── report_engine.py            ← report generation state-machine + interval logic
│   ├── mailer.py                   ← Brevo HTTP API → SMTP fallback → log-only delivery
│   ├── seed_users.py               ← idempotent migration + mock-user seed
│   ├── simulate_data.py            ← writes synthetic sensor_readings (5s tick, optional 2h seed)
│   ├── simulate_events.py          ← writes synthetic event_logs for testing
│   ├── install.ps1 / install.bat   ← one-shot interactive installer (self-elevates)
│   ├── uninstall.ps1 / .bat        ← stop + remove the NSSM service
│   ├── nssm.exe                    ← vendored NSSM binary
│   ├── init_db.sql                 ← aspirational multi-schema reference (not loaded today)
│   ├── tests\                      ← pytest suite
│   ├── requirements.txt            ← runtime deps only (this is what the installer bundles)
│   ├── requirements-dev.txt        ← requirements.txt + pytest, for local dev/test
│   ├── .env.example                ← copy to .env and fill JWT_SECRET (+ ENCRYPTION_KEY, Brevo/SMTP)
│   ├── .env                        ← LOCAL SECRETS — do NOT commit
│   ├── logs\                       ← NSSM stdout/stderr (installer creates this)
│   └── venv\                       ← Python 3.14 virtual environment (created by installer)
│
└── scada-frontend\                 ← React 19 + Vite SPA
    ├── package.json                ← react 19, react-router-dom 7, zustand, axios, @mui/material,
    │                                 echarts, echarts-for-react
    ├── vite.config.js              ← dev proxy /api,/ws → 127.0.0.1:8088
    ├── public\
    │   └── web.config              ← IIS rewrite rules (copied into dist on build)
    ├── src\
    │   ├── api\                    ← client.js (axios + auth interceptor), auth.js, users.js,
    │   │                             devices.js, alarms.js, readings.js, tags.js, panels.js,
    │   │                             dashboards.js, datasources.js, mimic.js, events.js, reports.js
    │   ├── stores\                 ← Zustand: auth, users, devices, alarms, connection
    │   ├── pages\                  ← page components:
    │   │  ├── LoginPage, ResetPasswordPage (public)
    │   │  ├── OverviewPage, DevicesPage, AlarmsPage, EventPage, SettingsPage (authenticated)
    │   │  ├── AccountsPage (admin-only)
    │   │  ├── live/LivePage + supporting files
    │   │  ├── monitor/MonitorPage + mimic editor components
    │   │  ├── reports/ReportPage, ReportBuilderPage
    │   │  └── NotFoundPage
    │   ├── components\             ← shared UI:
    │   │  ├── AppHeader, AppSidebar, ConnectionPill, GaugeTile, StatCard, TrendChart
    │   │  ├── charts/EChart (generic ECharts wrapper)
    │   │  ├── live/LivePanel + options/ (9 viz-type builders) + polling hooks
    │   │  ├── mimic/symbol library + hooks
    │   │  └── report/report block components
    │   ├── utils\                  ← mathExpr.js (safe transform evaluator),
    │   │                             seriesPalette.js (deterministic colour pick),
    │   │                             alertConditions.js
    │   ├── lib\, layouts\          ← utilities, layout wrappers
    │   ├── theme\, styles\         ← MUI theme + global styles
    │   └── router\routes.jsx       ← React Router v7 routes + RequireAuth guard
    └── dist\                       ← PRODUCTION BUILD OUTPUT (deploy this to IIS)
```

`dist\` is the artifact deployed to IIS; everything else under `scada-frontend\` is source.

---

## 2. Required stacks

| Component | Version / Edition | Why it's needed |
|---|---|---|
| **Python** | 3.14.x | Runs the FastAPI backend |
| **Node.js + npm** | Node 20+ / npm 10+ | Builds the React SPA |
| **PostgreSQL** | 18 (`postgresql-x64-18` Windows service) | Stores users, dashboard panels, `sensor_readings`, `variables_tag` |
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
   - `JWT_SECRET` (Enter = auto-generate `secrets.token_hex(32)`)
   - `ENCRYPTION_KEY` (Enter = auto-generate a Fernet key; encrypts saved plant passwords at rest)
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
Copy-Item .env.example .env         # then edit .env (set JWT_SECRET, optionally ENCRYPTION_KEY)
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

`JWT_SECRET` must be set to a real value here — the service refuses to start (fails the health
check above) if it's left blank or at a known placeholder value. There's no interactive prompt
on this manual path, so generate one yourself before starting the service:
`python -c "import secrets; print(secrets.token_hex(32))"`.

### 3.5 (Optional) Keep the demo data flowing

The Live and Trends pages read `public.sensor_readings`. In dev, generate fake data with the
simulator:

```powershell
cd C:\dev\scada-mml-backend
.\venv\Scripts\python.exe simulate_data.py            # forever, 5s tick
.\venv\Scripts\python.exe simulate_data.py --seed     # seed ~2h of history first, then run live
```

In production this is replaced by your real ingest pipeline; the SCADA system writes
`public.variables_tag` directly and the API only reads it.

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
| SPA fallback | non-file, non-`/api`, non-`/ws` | rewrite to `index.html` (React Router v7 history) |

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

The app uses **two kinds of database**, and the distinction is the reason there is almost
nothing to configure here.

| Key | Default | Example | Purpose |
|---|---|---|---|
| `DB_CONNECT_TIMEOUT` | `5` | `5` | Seconds to wait for a TCP connect to a *plant* database. Keep it small — without it an unreachable host blocks on the OS timeout. |

There is deliberately **no** `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`. Setting them
has no effect.

#### 4.1.1 App/config database vs plant data

**The app/config database is hardcoded** to `localhost:5432`, database `postgres`, user
`postgres`, password `P@ssw0rd` (`config.py`, `APP_DB_*`). It holds only MMLPortal's own
configuration: users, dashboards, panels, mimic layouts/assets/symbols, report templates and
settings, the saved datasource list, and each user's datasource selection.

It is hardcoded on purpose. Login and every page's chrome depend on it, so putting it on the
same machine as the API means the product **always boots and always logs in** regardless of
what the network is doing. That removes the failure this section used to describe, and the
failover machinery that worked around it (`DB_FALLBACK_*`, `DB_TARGET`,
`POST /api/system/db/failback`) has been removed with it.

> **Secure the local Postgres.** The password is in source control. Restrict `postgres` to
> local connections in `pg_hba.conf` and do not expose port 5432.

**Plant data** — readings, tags, events, alarms, report logs — comes from the rows in the
`datasources` table, managed on the Settings page. Each operator picks one or more in the
**data source selector in the top nav bar**, and every data endpoint answers for that
selection:

- **Live** panels draw one series per selected source, labelled with the source name.
- **Events** and **Alarms** merge rows from all selected sources, each tagged with its origin.
- **Reports** treat a machine as `(source, line, machine)`, so two plants that both have a
  `Line 1 / M01` are never added together.
- **Monitor** (mimic) reads the **first** selected source only — a symbol is one physical
  asset, so fanning it out would draw several plants' numbers onto one piece of equipment.

Monitor camera symbols are the exception: Settings requires one dedicated **Camera source**.
Their identity and defect batches come from that datasource's `cameras` and `camera_defect`
tables by camera code, independently of the top-nav selection. NG images remain filesystem-backed.

Each source is queried concurrently and independently. One unreachable plant costs its
connect timeout and appears as a warning banner on the page; the healthy sources still render.
A user with no explicit selection falls back to the lowest-id saved datasource, so a
single-plant site needs no configuration at all.

Admins can see the app database and the health of every saved datasource at
`GET /api/system/db`.

#### 4.1.2 Migrating an existing install

If your configuration currently lives in a remote database (the old `DB_HOST`), copy it to
localhost once:

```powershell
cd C:\dev\scada-mml-backend
.\venv\Scripts\python.exe migrate_config_to_local.py            # dry run — reports what it would copy
.\venv\Scripts\python.exe migrate_config_to_local.py --apply
```

It reads the source connection from the old `.env` values, copies only the config tables
(never plant data), preserves ids, resets sequences, and registers the remote as a datasource
selected for every user — so the app behaves exactly as it did before the split.

**Back up localhost from day one.** Configuration saved after the cutover exists *only* there.

If the source install had `ENCRYPTION_KEY` set, its `datasources.password` values are copied
byte-for-byte and will only decrypt here if this install's `ENCRYPTION_KEY` matches. The
migration prints a warning listing any datasource it can't decrypt after copying — re-enter
that connection's password from Settings → Data sources.

### 4.2 JWT & secrets at rest

| Key | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | `dev-insecure-change-me` | HMAC signing key. **Required** — the service refuses to start if this is blank, or left at `dev-insecure-change-me` or the `.env.example` placeholder. Generate with `python -c "import secrets;print(secrets.token_hex(32))"`. |
| `ACCESS_EXPIRE_MIN` | `30` | Access-token lifetime (minutes) |
| `REFRESH_EXPIRE_DAYS` | `7` | Refresh-token lifetime (days). Stored as `HttpOnly` cookie. |
| `RESET_EXPIRE_MIN` | `30` | Password-reset-token lifetime (minutes) |
| `ENCRYPTION_KEY` | *(empty)* | Optional. Encrypts saved plant-datasource passwords at rest. Blank keeps today's plaintext storage — nothing breaks either way. Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Setting it encrypts new/changed passwords immediately and sweeps existing plaintext rows into the encrypted form on the next boot; a value without the `fernet$` prefix is always treated as legacy plaintext, so turning this on is never disruptive. |

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

### 5.4 Offline installer (industrial network deployment)

For a plant-floor PC with **no internet access** and no Python/Node/PostgreSQL preinstalled, the
[`installer/`](installer/) directory produces a single double-clickable
`MMLPortalSetup-<version>.exe` (Inno Setup) that provisions everything unattended: a bundled
PostgreSQL 18 (silent install), a self-contained Python + backend deps, the built SPA, IIS + ARR
reverse proxy, the `mml-api` NSSM service, and a local hostname binding — no manual steps.

> **Before deploying: allowlist with the plant's antivirus/EDR.** The installer is not
> code-signed (see the comment in `installer/MMLPortal.iss`) and it bundles several binaries
> that commonly trigger AV/EDR heuristics on first run: `MMLPortalSetup-*.exe` itself, the
> extracted `nssm.exe`, and the bundled `postgresql-18-windows-x64.exe` /
> `rewrite_amd64_en-US.msi` / `requestRouter_amd64.msi` under `{app}\redist\`. On a locked-down
> industrial PC (managed AV, EDR, or AppLocker/WDAC policy) any of these can be silently
> quarantined *after* Setup extracts them but *before* `postinstall.ps1` uses them, causing a
> partial install (e.g. the NSSM service registration fails because `tools\nssm.exe` vanished
> mid-run) with no obvious error dialog. Before running on a production plant PC:
> 1. Get the target PC's AV/EDR to allowlist/exclude `C:\MMLPortal\` (the install directory) and
>    the `MMLPortalSetup-<version>.exe` file itself, or temporarily disable real-time protection
>    for the duration of the install.
> 2. Expect a Windows SmartScreen "Windows protected your PC" prompt on first launch since the
>    `.exe` is unsigned — click **More info → Run anyway**.
> 3. If a step fails partway through, check `C:\ProgramData\MMLPortal\install.log` first — a
>    missing/quarantined file under `{app}\tools\` or `{app}\redist\` is the most likely cause.

**Build once, on a developer machine with internet** (this is never run on the target PC):

```powershell
cd C:\dev
.\installer\scripts\fetch-redist.ps1   # downloads PostgreSQL 18, IIS Rewrite/ARR, Python embeddable
.\installer\scripts\build.ps1          # npm build, assembles self-contained Python, invokes ISCC.exe
# -> installer\Output\MMLPortalSetup-<version>.exe
```

**Run on the target PC** (fully offline, needs admin): double-click the `.exe`. The wizard asks for
a local hostname (default `mmlportal.local`), a port (default `80`), and whether to install the
bundled PostgreSQL (auto-unchecked if `postgresql-x64-18` is already running). It installs
PostgreSQL if requested, registers the `mml-api` NSSM service, enables the IIS roles + ARR proxy,
creates the IIS site with a host-header binding, and appends the hostname to
`C:\Windows\System32\drivers\etc\hosts`. A full pass/fail summary is written to
`C:\ProgramData\MMLPortal\install.log`.

**LAN caveat**: the installer only configures the server it runs on. Every *other* PC on the local
network that needs to browse to `http://<hostname>/` must get its own `hosts` file entry (pointing
at this server's real LAN IP, not `127.0.0.1`) or a DNS A record — that step is outside the
installer's reach.

Uninstalling (Control Panel → Programs, or `installer\scripts\uninstall.ps1` directly) stops and
removes the NSSM service and IIS site, but deliberately leaves PostgreSQL, `.env`, and `logs\` in
place — same data-safety stance as `scada-mml-backend\uninstall.ps1`.

---

## 6. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| **`install.ps1` says NSSM not found** | The repo vendors `nssm.exe` next to `install.ps1` — make sure it wasn't deleted. Otherwise install NSSM and add to PATH, or drop `nssm.exe` into `scada-mml-backend\`. |
| **Service dead / login unavailable when a plant host is off** | No longer the behaviour: login uses the local app database and is unaffected. The dead plant shows as a warning banner on the pages that read it, and the other selected sources still render. See §4.1.1. |
| **Signed in, but every page is empty and a red banner says the database is unreachable** | The API is up and *its own* database (localhost) is not. `Get-Service postgresql*`; the service recovers on its own once Postgres is back, no restart needed. |
| **Live/Events/Alarms are empty but the app works fine** | No data source is selected, or the selected one has no matching tables. Check the selector in the top nav bar and `GET /api/system/db` (admin) for per-datasource health. |
| **Pages show the wrong plant's numbers after switching sources** | Reload once. If it persists it is a bug — every data query key includes the selection precisely to prevent this. |
| **`install.ps1` finishes but health check fails** | Check `scada-mml-backend\logs\stderr.log`. Usually local Postgres is not running or does not accept `postgres` / `P@ssw0rd`. |
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
| **New numeric column on `public.variables_tag` doesn't show up in the panel editor** | Fields are introspected once per process and cached. `Restart-Service mml-api` to re-discover. |
| **`Failed to fetch dynamically imported module …Page.jsx` in dev** | Two Vite servers are fighting over port 5173. Kill stray `node` processes (`Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where CommandLine -like '*vite*' \| Stop-Process -Force`). |
| **`psql` not found** | Add `C:\Program Files\PostgreSQL\18\bin` to PATH, or call the full path. |

For architecture, code internals, the full API reference, and the dynamic `variables_tag` introspection,
see [`MML_DEVELOPMENT.md`](MML_DEVELOPMENT.md). For a click-through end-to-end visualization,
open [`workflow.html`](workflow.html).
