---
name: mmlportal-patterns
description: >-
  Conventions for the MMLPortal SCADA monorepo. Apply when adding or modifying
  code in scada-frontend (Vue 3 pages, Pinia stores, axios API wrappers, the
  Live dashboard) or scada-mml-backend (FastAPI routers, auth, db access).
  Encodes the canonical shape of each artifact — SFCs, stores, API wrappers,
  routers, auth flow, page layout, and the Live dashboard panel model — so new
  code matches the existing style.
version: 1.0.0
source: local-analysis
---

# MMLPortal Patterns

MMLPortal is a SCADA monitoring system. Monorepo, two independent apps:

- `scada-mml-backend/` — FastAPI REST API (Python 3.14)
- `scada-frontend/` — Vue 3 + Vite SPA

This skill teaches *how to write code that matches the codebase*. For
architecture, the full endpoint list, and DB schemas, read `CLAUDE.md` and
`DEVELOPMENT.md` instead — don't duplicate them here.

---

## Stacks (exact, from lockfiles)

**Frontend** — Vue `^3.5` (`<script setup>` SFCs), Vite `^8`, Element Plus
`^2.14` + `@element-plus/icons-vue`, ECharts `^6` via `vue-echarts` `^8`,
Pinia `^3`, Vue Router `^5`, axios `^1.16`, `grid-layout-plus` `^1.1` (Live
grid). Auto-import via `unplugin-auto-import` + `unplugin-vue-components`.

**Backend** — FastAPI `0.136`, uvicorn, `psycopg[binary]` `3.x`, PyJWT `2.x`,
python-dotenv. **No ORM** — raw SQL via psycopg 3. Python 3.14 stdlib only for
crypto (`hashlib.scrypt`).

**DB** — PostgreSQL. App reads `public.sensor_readings` and `public.variables_tag`;
persists its own `dashboard_panels` and `dashboards` tables.

---

## Coding style

### Frontend SFCs
- Always `<script setup>`. Open every component/page with a JSDoc block
  describing its role and (for pages) its route. Example from
  `src/layouts/AppShell.vue`:
  ```vue
  <script setup>
  /**
   * AppShell — authenticated application layout (used by all protected routes).
   * Renders a collapsible AppSidebar on the left, a fixed AppHeader on top...
   */
  import { ref } from 'vue'
  ```
- Props use typed `defineProps` with defaults: `defineProps({ collapsed: { type: Boolean, default: false } })`. Events via `defineEmits(['toggle'])`.
- Imports use the `@/` alias for `src/`.
- Element Plus components (`el-*`) and icons are auto-imported — do **not** add explicit imports for them. Use `ElMessage` / `ElMessageBox` from `'element-plus'` for toasts and confirms.
- Dialogs follow one shape: `el-dialog v-model` + `el-form label-position="top"` + a `#footer` template with Cancel / primary action, and an `el-alert` for inline errors (see `AppHeader.vue` change-password dialog and `LoginPage.vue`).

### Scoped styles + design tokens
- Styles are `<style scoped>`. Use the CSS custom properties from
  `src/styles/tokens.css` — **never hardcode** spacing/colors in the
  authenticated app: `var(--space-4)`, `var(--accent)`, `var(--fg-muted)`,
  `var(--radius-sm)`, `var(--bg-panel)`, etc.
- Class naming is BEM-ish: block `__element` and `--modifier`
  (`.shell__content`, `.tab-btn--active`, `.comm-metric__fill--cyan`).
- Exception: `LoginPage.vue` and `ResetPasswordPage.vue` are public, pre-theme
  screens with a bespoke hardcoded SCADA palette (`#3aa0ff`, `#05091a`…). Token
  rule applies inside `AppShell` (everything behind auth), not these two.

### Pinia stores (`src/stores/`)
Options API style — `defineStore('name', { state, getters, actions })`. State is
a function; getters derive booleans/counts; actions are async and wrap the
matching `src/api/*` calls. See `src/stores/auth.js`.

### API wrappers (`src/api/`)
Thin, one file per domain. Each function calls `apiClient`, returns `data`, and
documents the response shape in a trailing comment:
```js
export async function fetchPanels(dashboardId) {
  const { data } = await apiClient.get('/panels', {
    params: dashboardId ? { dashboard_id: dashboardId } : {},
  })
  return data // [{ id, title, metric, chart_type, position, dashboard_id, ... }]
}
```
All requests go through `apiClient` from `src/api/client.js` (never bare axios).

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
- Config via `config.py` (env + defaults); module-level `logger = logging.getLogger("mml-api.<area>")`.

---

## Authentication

Two-token JWT scheme (see `auth.py`, `security.py`, `src/api/client.js`,
`src/stores/auth.js`):

- **Access token** — short-lived JWT (`type:"access"`, 30 min). Returned in the
  login/refresh JSON body. Frontend keeps it in **module memory only**
  (`client.js` `_accessToken`), never `localStorage`. Attached as
  `Authorization: Bearer <token>` by a request interceptor.
- **Refresh token** — long-lived JWT (`type:"refresh"`, 7 days) set as an
  **HttpOnly, SameSite=Strict cookie** scoped to `path="/api/auth"`. JS can't
  read it; the browser sends it only to auth endpoints.
- **Reset token** — single-use JWT (`type:"reset"`, 30 min) carrying a `jti`,
  denylisted in-memory after use.
- Passwords: stdlib `hashlib.scrypt`, stored self-describing as
  `scrypt$<salt_hex>$<digest_hex>`; verified with `hmac.compare_digest`.
- **401 auto-refresh**: the axios response interceptor catches a 401 (skipping
  `/auth/*` calls), calls `auth.refresh()`, retries the original request, and
  queues concurrent requests while one refresh is in flight. On refresh failure
  it clears the session and redirects to `/login`.
- When adding a new token type, always check `payload.get("type")` matches and
  validate via `security.decode_token` inside a `try/except jwt.PyJWTError`.

Endpoints live under `/api/auth`: login, register (always role `operator`), me,
refresh (rotates), logout (revokes jti), change-password, forgot-password
(generic response, emails via background task), reset-password (returns 400 not
401 so the interceptor doesn't hijack it).

---

## Login system

`LoginPage.vue` (route `/login`, `meta.public`) is a full-screen two-column card:
decorative brand/status panel (hidden under 680px) + the credentials form. It
drives three flows through the auth store and `src/api/auth.js`:

- **Sign in** → `auth.signIn(username, password)`, then redirect to the
  `?redirect=` target. Open-redirect guard: only honor a string starting with
  `'/'`.
- **Create account** dialog → `auth.signUp(...)` (server forces `operator`).
- **Forgot password** dialog → `forgotPassword(email)` (always shows a generic
  "if registered, a link was sent" message).

Session restore: `src/router/index.js` `beforeEach` runs `auth.initialize()`
once on first navigation, which silently calls `/auth/refresh` with the cookie —
this is how a logged-in user survives a page reload (access token is memory-only).

---

## Page layout

- **Routing** (`src/router/index.js`): lazy `component: () => import(...)`. Two
  public routes (`/login`, `/reset-password`, `meta.public`). All app pages are
  children of the `AppShell` layout under `/` with `meta.requiresAuth`. Each
  child sets `meta.title` and `meta.icon` (Element Plus icon name). Admin-only
  pages add `meta.requiresRole: 'admin'`.
- **Guards** in `beforeEach`: redirect unauthenticated → `login` (preserving
  `redirect`), wrong-role → `overview`, and logged-in-hitting-`/login` →
  `overview`. `afterEach` sets `document.title` from `meta.title`.
- **Shell** (`src/layouts/AppShell.vue`): `el-container` → collapsible
  `el-aside` (`AppSidebar`) + `el-header` (`AppHeader`) + scrollable `el-main`
  wrapping a `<router-view>` with a fade `<transition>`. Sidebar collapse is
  local `ref` state passed down as a prop / lifted via a `toggle` emit.
- **Sidebar** (`AppSidebar.vue`): nav items are a `computed` array; the Accounts
  item is pushed only when `auth.role === 'admin'`. Keep this list and the
  router children in sync when adding a page.
- **Header** (`AppHeader.vue`): page title from `route.meta.title`,
  `ConnectionPill`, and a user dropdown (Change password / Sign out).

**Adding a page:** create `src/pages/XxxPage.vue` (`<script setup>` + JSDoc) →
register a child route with `meta.title`/`meta.icon` (+ `requiresRole` if
admin) → add the nav entry in `AppSidebar.vue`'s `items`.

---

## Dashboard layout (the Live grid)

`/live` (`LivePage.vue`) is an admin-curated dashboard of `LivePanel` tiles laid
out with `grid-layout-plus`. Panels persist in Postgres (`dashboard_panels`) and
each tile self-polls at a whitelisted interval. Admins can add/edit/delete/drag/
resize; operators get a read-only grid (`canManage = auth.role === 'admin'`).

The **panel model** (`panels.py` `PanelIn`/`PanelOut`, mirrored by
`src/api/panels.js`) binds each panel to one `source`:
- `device` — `device_id` + `metric` from `public.sensor_readings`
- `tag` — `tag_name` + numeric `metric` column of `public.variables_tag`
  (columns discovered dynamically from `information_schema`, cached per process)
- `table` — generic `table_name` + numeric `metric` (+ optional `filter_col`,
  `ts_col`, and `options.value_cols` for multi-column series)

Server-side whitelists in `panels.py` that **must stay in sync** with the
frontend:
- `VALID_CHART_TYPES` ↔ `LivePage.vue` `VIZ_TYPES` (timeseries, bar, stat,
  gauge, bargauge, histogram, table, pie, heatmap, scatter, statetimeline,
  candlestick)
- `VALID_POLL_INTERVALS = {5, 30, 60, 600, 1800, 3600}` ↔ `POLL_INTERVALS`
- `VALID_SOURCES = {device, tag, table}`

Per-chart-type tuning lives in `LivePage.vue` `PARAM_SCHEMA` (`switch` /
`number` / `enum` fields) and is stored in the panel's `options` JSON.
`options.transform` is a tiny safe expression (`value`, `+ - * / ^`,
`abs/sqrt/pow/min/max/floor/ceil/round`) evaluated by `src/utils/mathExpr.js`
(no `eval`/`Function`). Series colors come from `src/utils/seriesPalette.js`.

**Rule of thumb:** adding a chart type or poll interval is a *two-sided* change —
update the backend whitelist **and** the frontend `VIZ_TYPES`/`PARAM_SCHEMA`/
`POLL_INTERVALS`, plus a renderer branch in `LivePanel.vue`.

---

## Commit style

Not conventional commits. Messages are **capitalized, imperative sentences
ending in a period**, often scoped to the area touched:

- `Add multi-dashboard functionality to LivePage and backend.`
- `Refactor unit handling in LivePanel and LivePage for per-series configuration.`
- `Improve active alarms handling and dialog usability.`

Match that: one line, capitalized verb first, name the feature/area. Don't add
`feat:`/`fix:` prefixes.
