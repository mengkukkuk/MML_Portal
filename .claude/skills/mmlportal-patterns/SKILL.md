---
name: mmlportal-patterns
description: >-
  Conventions for the MMLPortal SCADA monorepo. Apply when adding or modifying
  code in scada-frontend (React 19 pages, Zustand stores, TanStack Query,
  axios API wrappers, MUI + CSS Modules, the Live dashboard) or
  scada-mml-backend (FastAPI routers, auth, db access). Encodes the canonical
  shape of each artifact — pages, stores, API wrappers, routers, auth flow,
  routing/layout, and the Live dashboard panel model — so new code matches
  the existing style.
version: 1.1.0
source: local-analysis
---

# MMLPortal Patterns

MMLPortal is a SCADA monitoring system. Monorepo, two independent apps:

- `scada-mml-backend/` — FastAPI REST API (Python 3.14)
- `scada-frontend/` — React 19 + Vite SPA (JavaScript/JSX, no TypeScript)

This skill teaches *how to write code that matches the codebase*. For
architecture, the full endpoint list, and DB schemas, read `docs/CLAUDE.md` and
`docs/MML_DEVELOPMENT.md` instead — don't duplicate them here.

> The frontend was migrated from Vue 3. Some comments still mention the old
> Vue/Pinia code ("ported from ..."); follow the React patterns below, not those
> historical notes.

---

## Stacks (from `package.json` / `requirements.txt`)

**Frontend** — React `^19` (function components, hooks), Vite `^8`, MUI
`^7` (`@mui/material`, `@mui/icons-material`, `@mui/x-date-pickers`), TanStack
Query `^5`, Zustand `^5`, react-router-dom `^7` (`createBrowserRouter`), axios
`^1.16`, ECharts `^6` (wrapped by `src/components/charts/EChart.jsx`),
`react-grid-layout` (Live grid), `react-hook-form`, `exceljs`, dayjs. i18n is
home-grown (`src/i18n`, Zustand-backed). Tests are plain `node --test` files
next to the code (`*.test.js`), registered by name in the `npm test` script.

**Backend** — FastAPI `0.136`, uvicorn, `psycopg[binary]` `3.x` (+ `psycopg_pool`),
PyJWT `2.x`, python-dotenv. **No ORM** — raw SQL via psycopg 3. Python 3.14 stdlib
only for password hashing (`hashlib.scrypt`).

**DB** — PostgreSQL. App reads plant tables (e.g. `public.sensor_readings`,
`public.variables_tag`); persists its own `dashboard_panels` and `dashboards`
tables.

---

## Coding style

### Frontend components and pages
- Function components, **default export**, one component per file named after
  the file (`DevicesPage.jsx`). Open every page/component with a JSDoc block
  describing its role and (for pages) its route. Example from
  `src/pages/DevicesPage.jsx`:
  ```jsx
  /**
   * DevicesPage — device inventory table (route: /devices).
   * Fetches the device list via TanStack Query on mount ...
   */
  export default function DevicesPage() {
    const { data: list = [], isFetching, refetch } = useQuery({
      queryKey: ['devices'],
      queryFn: fetchDevices,
    })
    ...
  ```
- Imports use the `@/` alias for `src/`.
- **MUI imports are per-path**, never the barrel:
  `import Button from '@mui/material/Button'`,
  `import RefreshIcon from '@mui/icons-material/Refresh'`. A barrel import pulls
  ~11k modules through Vite's optimizer (see the note in `router/routes.jsx`).
- Dialogs use MUI `Dialog` with a title, form body, and Cancel / primary actions;
  forms use `react-hook-form` where there is real validation. Surface API errors
  with `apiErrorMessage(e, 'Fallback text')` from `@/api/client`.
- Component folders: shared components live in `src/components/<Name>/<Name>.jsx`
  with a sibling `<Name>.module.css`; page-specific pieces live next to the page
  (`src/pages/monitor/`, `src/pages/live/`, `src/pages/ap/`, `src/pages/reports/`).
- Pure logic (formatting, payload building, selection, trend math) is split into
  plain `.js` modules with a colocated `*.test.js`, not buried in components.
  When you add a test file, add it to the `test` script in `package.json`.

### Styles and design tokens
- **CSS Modules**: `X.module.css` imported as `styles` (`className={styles.page}`).
- Use the CSS custom properties from `src/styles/tokens.css` — **never hardcode**
  spacing/colors in the authenticated app: `var(--space-4)`, `var(--accent)`,
  `var(--fg-muted)`, `var(--radius-sm)`, `var(--bg-panel)`, etc.
- Themes are `data-theme` values on `<html>` (persisted in the settings store);
  MUI's palette is derived in `src/theme/muiTheme.js` from the active theme's
  light/dark mode. Don't hardcode colors that would break a light theme.
- Class naming is BEM-ish within a module (`.shell`, `.content`, `.fade`).
  Add an unhashed global class alongside the module class only when a global
  stylesheet must reach the element (`AppShell` does this for `styles/print.css`).
- Exception: `LoginPage` and `ResetPasswordPage` are public, pre-theme screens
  with a bespoke hardcoded SCADA palette. The token rule applies inside
  `AppShell` (everything behind auth), not these two.

### State: Zustand for client state, TanStack Query for server data
- **Client state** lives in Zustand stores in `src/stores/` (`auth.js`,
  `connection.js`, `settings.js`, `license.js`, `datasourceSelection.js`):
  `export const useXStore = create((set, get) => ({ ...state, ...actions }))`.
  Actions are async functions that call `src/api/*` and `set(...)`. Select with
  a selector (`useAuthStore((s) => s.user?.role ?? null)`) so components
  re-render only on what they use. "Getters" are plain functions on the store
  (`isLoggedIn: () => get().hasToken`).
- **Server data** uses `useQuery({ queryKey, queryFn })` / `useMutation` with the
  `src/api/*` wrappers; the shared `queryClient` (`src/lib/queryClient.js`) sets
  `retry: 0` and `refetchOnWindowFocus: false` on purpose (the axios client
  already retries transient gateway errors once, and the Live grid polls on its
  own cadence). Don't re-enable them per query without a reason.
- Don't mirror server data into Zustand; let Query own it.

### API wrappers (`src/api/`)
Thin, one file per domain. Each function calls `apiClient`, returns `data`, and
documents the response shape in a trailing comment:
```js
export async function fetchPanels(dashboardId) {
  const { data } = await apiClient.get('/panels', {
    params: dashboardId ? { dashboard_id: dashboardId } : {},
  })
  return data // [{ id, title, device_id, metric, window_minutes, chart_type, position, ... }]
}
```
All requests go through `apiClient` from `src/api/client.js` (never bare axios).
The client attaches the Bearer token, retries 502/503/504 and network failures
once after 1.5 s, strips the JSON `Content-Type` for `FormData` bodies (so
uploads get a proper multipart boundary), and handles 401 refresh (below).

### Backend routers
One module per domain, each exposing `router = APIRouter(prefix="/api/...", tags=[...])`,
mounted in `main.py`. Conventions (see `panels.py`, `auth.py`):
- Pydantic `XxxIn` (request) and `XxxOut` (`response_model`) models, with
  `Field(...)` constraints (`min_length`, `ge`, `le`).
- Gate every endpoint with a dependency: `Depends(get_current_user)` for
  authenticated reads, `Depends(require_admin)` for admin-only writes. Unused
  injected user is named `_user` / `_admin`.
- **All SQL lives in `db.py`** — routers call `db.list_panels(...)`,
  `db.create_user(...)`, etc. Routers never embed SQL.
- Validate against explicit whitelists (sets/frozensets at module top) and
  raise `HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=...)`
  with a human-readable message. Use the `status.HTTP_*` constants, not bare ints.
  FastAPI errors carry `detail` (not `message`) — the frontend reads it via
  `apiErrorMessage`.
- Config via `config.py` (env + defaults); module-level `logger = logging.getLogger("mml-api.<area>")`.

---

## Authentication

Two-token JWT scheme (see `auth.py`, `security.py`, `src/api/client.js`,
`src/stores/auth.js`):

- **Access token** — short-lived JWT (`type:"access"`, 30 min). Returned in the
  login/refresh JSON body. Frontend keeps it in **module memory only**
  (`client.js` `_accessToken`, set via `setAccessToken`), never `localStorage`.
  Attached as `Authorization: Bearer <token>` by a request interceptor. The auth
  store only holds a boolean `hasToken`, never the token.
- **Refresh token** — long-lived JWT (`type:"refresh"`, 7 days) set as an
  **HttpOnly, SameSite=Strict cookie** scoped to `path="/api/auth"`. JS can't
  read it; the browser sends it only to auth endpoints (`withCredentials: true`).
- **Reset token** — single-use JWT (`type:"reset"`, 30 min) carrying a `jti`,
  denylisted in-memory after use.
- Passwords: stdlib `hashlib.scrypt`, stored self-describing as
  `scrypt$<salt_hex>$<digest_hex>`; verified with `hmac.compare_digest`.
- **401 auto-refresh**: the axios response interceptor catches a 401 (skipping
  `/auth/*` calls), calls the refresh endpoint, retries the original request,
  and queues concurrent requests while one refresh is in flight. On refresh
  failure it clears the session and redirects to `/login`.
- When adding a new token type, always check `payload.get("type")` matches and
  validate via `security.decode_token` inside a `try/except jwt.PyJWTError`.

Endpoints live under `/api/auth`: login, register (always role `operator`), me,
refresh (rotates), logout (revokes jti), change-password, forgot-password
(generic response, emails via background task), reset-password (returns 400 not
401 so the interceptor doesn't hijack it).

---

## Login system

`LoginPage.jsx` (route `/login`) is a full-screen card with a brand/status
panel and the credentials form. It drives three flows through the auth store and
`src/api/auth.js`:

- **Sign in** → `useAuthStore.signIn(username, password)`, then `navigate()` to
  the `?redirect=` target. `LoginPage` only honors a string starting with `'/'`;
  this is an *incomplete* open-redirect guard (`//evil.com` passes) and
  `RequireAuth` round-trips the path verbatim. Don't copy it for new redirects —
  reject `//` and `/\` prefixes too.
- **Create account** → `signUp(...)` (server forces `operator`).
- **Forgot password** → `forgotPassword(email)` (always shows a generic
  "if registered, a link was sent" message).

Session restore: on startup `initialize()` in the auth store (driven by
`src/lib/sessionBootstrap.js`) silently calls the refresh endpoint with the
cookie — this is how a logged-in user survives a page reload (the access token
is memory-only).

---

## Routing and page layout

- **Routes** (`src/router/routes.jsx`): `createBrowserRouter` with a root
  `<RequireAuth />` element. Pages are `lazy(() => import(...))` and wrapped by
  the local `page(Component)` helper (a `Suspense` with `fallback={null}`). Two
  public routes (`/login`, `/reset-password`); all app pages are children of
  `<AppShell />` at `/` with `handle: { requiresAuth: true }`; bare `/` redirects
  to `monitor`; the `*` catch-all (`NotFoundPage`) sits outside the shell.
- **Route metadata** is the `handle` object, not `meta`: `{ title, icon,
  requiresRole: 'admin' }`. `icon` is an imported MUI icon component (per-path
  import). Current app routes: `ap`, `devices`, `alarms`, `live`, `monitor`,
  `events`, `reports` (+ `:templateId`, `new`, `:templateId/edit`), `settings`,
  `accounts` (admin).
- **Guards** (`src/router/RequireAuth.jsx`) read the matched routes' `handle` via
  `useMatches()`: unauthenticated → `/login?redirect=<fullPath>`, wrong role →
  `/`, signed-in user on `handle.isLoginRoute` → `/`. `TitleSync.jsx` sets
  `document.title` from `handle.title`.
- **Shell** (`src/layouts/AppShell.jsx`): collapsible `<aside>` (`AppSidebar`) +
  `<header>` (`AppHeader`), `DbStatusBanner`, `LicenseStatusBanner`, and a
  scrollable `<main>` wrapping `<Outlet />` with a fade keyed on pathname.
  Sidebar collapse is local `useState`, passed down as a prop.
- **Sidebar** (`components/AppSidebar/AppSidebar.jsx`): nav items are role-aware
  (Accounts only for `role === 'admin'`). Keep this list and the router children
  in sync when adding a page.

**Adding a page:** create `src/pages/XxxPage.jsx` (default export + JSDoc, with a
`XxxPage.module.css`) → add a `lazy` import and a child route in `routes.jsx`
with `handle: { title, icon }` (+ `requiresRole` if admin) → add the nav entry
in `AppSidebar.jsx`. Add an `src/api/xxx.js` wrapper if it needs data.

---

## Dashboard layout (the Live grid)

`/live` (`pages/live/LivePage.jsx`) is an admin-curated dashboard of `LivePanel`
tiles (`components/live/LivePanel.jsx`) laid out with `react-grid-layout`.
Panels persist in Postgres (`dashboard_panels`) and each tile self-polls at a
whitelisted interval (`usePanelPolling.js`, `usePanelSeries.js`). Admins can
add/edit/delete/drag/resize via `PanelEditorDialog.jsx`; operators get a
read-only grid.

The **panel model** (`panels.py` `PanelIn`/`PanelOut`, mirrored by
`src/api/panels.js` and `pages/live/panelPayload.js`) binds each panel to one
`source`:
- `device` — `device_id` + `metric` from `public.sensor_readings`
- `tag` — `tag_name` + numeric `metric` column of `public.variables_tag`
  (columns discovered dynamically from `information_schema`, cached per process)
- `table` — generic `table_name` + numeric `metric` (+ optional `filter_col`,
  `ts_col`, and `options.value_cols` for multi-column series)

Server-side whitelists in `panels.py` that **must stay in sync** with the
frontend:
- `VALID_CHART_TYPES` ↔ `VIZ_TYPE_META` in `panelPayload.js` (timeseries, bar,
  stat, gauge, bargauge, histogram, table, pie, heatmap, scatter, statetimeline,
  candlestick)
- `VALID_POLL_INTERVALS = {5, 30, 60, 600, 1800, 3600}` ↔ `POLL_INTERVAL_OPTIONS`
  (`panelPayload.js`) **and** `POLL_INTERVALS` (`usePanelSeries.js`, compact
  labels for the gear popover) — two frontend copies on purpose
- `VALID_SOURCES = {device, tag, table}`

Per-chart-type tuning lives in `panelPayload.js` `PARAM_SCHEMA` (`switch` /
`number` / `enum` fields, rendered by `ParamFields.jsx`) and is stored in the
panel's `options` JSON. `options.transform` is a tiny safe expression (`value`,
`+ - * / ^`, `abs/sqrt/pow/min/max/floor/ceil/round`) evaluated by
`src/utils/mathExpr.js` (no `eval`/`Function`). Series colors come from
`src/utils/seriesPalette.js`. Each chart type has its own ECharts option builder
in `components/live/options/<type>.js` (registered in `options/index.js`).

**Rule of thumb:** adding a chart type or poll interval is a *two-sided* change —
update the backend whitelist **and** the frontend `VIZ_TYPE_META` / `PARAM_SCHEMA`
/ `POLL_INTERVAL_OPTIONS` / `POLL_INTERVALS`, plus an option builder in
`components/live/options/` and a branch in `LivePanel.jsx`.

---

## Monitor page structure (`src/pages/monitor/`)

`MonitorPage.jsx` only composes; don't grow it. Put new code where it belongs:

- **`hooks/`** — state and effects, one concern per hook, called in dependency
  order: `useMimicDrawings` (which drawing, `?mimic=`) → `useMimicDocument`
  (load/seed/save, undo session) → `useMimicData` (polling, tags, custom
  symbols) → `useMimicSelection` → `useLayoutEdits` (every canvas/inspector
  edit) → `useDialogActions` (dialog results) → `useEditLifecycle`
  (edit mode, save, cancel, unsaved guard). Also `useMonitorUi` (shared dialog
  and view flags), `useEditorChrome`, `useFullscreen`, `useEditorShortcuts`,
  `useMimicFiles`, `useNotify`. Hooks take what they need as arguments; no
  context or global store.
- **`view/`** — presentational components (`OverviewPanel`, `MimicViewer`,
  `MimicEditor`, `EditorInspector`, `MonitorDialogs`, …) that receive hook
  results as props.
- **Pure logic** goes in plain modules with a colocated `*.test.js`:
  `layoutOps.js` (`(doc, …) => doc` edits), `monitorStatus.js`, `sheet.js`,
  plus the older `layoutDoc.js`, `editorSession.js`, `kpiBoxes.js`. Use
  `.js` extensions on relative imports inside them (node `--test` has no
  alias or JSX), and register the test file in the `npm test` script.
- Edits to the drawing always go through the editor session's `commit`
  (undoable) or `preview` (drag in progress) — never straight to the server.

---

## Commit style

Recent history uses conventional-style prefixes with an area scope, lower-case
and unpunctuated, mixed with some plain short messages:

- `feat(reports/trend): add min/max bucket sampling and zoom slider for long windows`
- `fix(frontend): resolve cached URL sync issue in useCameraFrameUrl`
- `chore: remove unused files and obsolete frontend store`

Prefer `type(scope): summary` (`feat`, `fix`, `chore`, `refactor`) in the imperative.
