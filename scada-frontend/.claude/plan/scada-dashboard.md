# SCADA Dashboard Scaffold — Option B (Element Plus + ECharts)

**Status:** awaiting approval
**Date:** 2026-06-02
**Stack:** Vue 3.5 · Vite 8 · vue-router 4 · Pinia 2 · Element Plus · ECharts 5 · axios

---

## 1. Dependencies to install

```
pnpm/npm add  vue-router pinia element-plus @element-plus/icons-vue echarts vue-echarts axios
npm add -D    unplugin-vue-components unplugin-auto-import @types/node
```

`unplugin-vue-components` + `unplugin-auto-import` give us tree-shaken, on-demand Element Plus imports — no full-lib bundle.

## 2. Folder structure (target)

```
src/
├── main.js                  # app bootstrap: Pinia, router, ElementPlus dark theme
├── App.vue                  # mounts <router-view/>
├── api/
│   ├── client.js            # axios instance, baseURL = VITE_API_BASE
│   ├── devices.js
│   └── alarms.js
├── assets/                  # keep hero.png etc. (will trim later)
├── styles/
│   ├── tokens.css           # CSS custom props: spacing, radius, status colors
│   ├── theme-dark.css       # SCADA dark palette overrides for Element Plus
│   └── index.css            # global resets, imports tokens + theme
├── layouts/
│   └── AppShell.vue         # el-container shell (sidebar + header + main)
├── components/
│   ├── AppSidebar.vue       # el-menu, route-driven
│   ├── AppHeader.vue        # title, connection pill, user dropdown, theme toggle
│   ├── ConnectionPill.vue   # green/amber/red live status
│   ├── StatCard.vue         # KPI tile (label + value + delta)
│   ├── GaugeTile.vue        # ECharts gauge wrapper
│   └── TrendChart.vue       # ECharts line chart wrapper
├── pages/
│   ├── OverviewPage.vue     # default route — grid of StatCard + GaugeTile + TrendChart
│   ├── DevicesPage.vue      # el-table placeholder
│   ├── AlarmsPage.vue       # el-table + severity tags placeholder
│   ├── TrendsPage.vue       # full-width TrendChart placeholder
│   └── SettingsPage.vue     # simple el-form placeholder
├── router/
│   └── index.js             # createRouter + 5 routes nested under AppShell
└── stores/
    ├── connection.js        # pinia: status, lastHeartbeatAt
    ├── devices.js
    └── alarms.js
```

## 3. Routing

`createRouter({ history: createWebHistory() })`, all real routes nested under `AppShell` so the chrome persists:

```
/            → OverviewPage
/devices     → DevicesPage
/alarms      → AlarmsPage
/trends      → TrendsPage
/settings    → SettingsPage
/:catchAll   → 404
```

## 4. Layout & styling

- **Grid:** `AppShell` uses `el-container` with `el-aside` (collapsible, 64↔220px) + `el-main`.
- **Overview grid:** CSS Grid `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`, `gap: var(--space-4)`.
- **Theme:** SCADA-typical dark palette. Tokens in `styles/tokens.css`:
  ```
  --bg-app:#0b1220; --bg-panel:#111a2c; --bg-elev:#172238;
  --fg:#e6edf7; --fg-muted:#8a99b3;
  --accent:#3aa0ff;
  --ok:#22c55e; --warn:#f59e0b; --crit:#ef4444;
  --radius:10px; --space-4:16px; --space-6:24px;
  ```
- **Element Plus dark mode:** import `element-plus/theme-chalk/dark/css-vars.css` and add `<html class="dark">`.
- **Responsiveness:** sidebar auto-collapses below 960px; tile grid reflows via `minmax()`; no fixed widths inside cards.
- **Accessibility:** `aria-label` on nav links, focus-visible outlines preserved, sufficient color contrast against `--bg-app`.

## 5. State (Pinia)

- `useConnectionStore` — `{ status: 'connected'|'degraded'|'offline', lastHeartbeatAt }`. Polled later via `/api/health`.
- `useDevicesStore` — `{ list, byId, loading, error, fetchAll() }`.
- `useAlarmsStore` — `{ active, history, loading, error, fetchActive() }`.

Real fetching is **stubbed** in this scaffold (returns mock arrays after 200 ms). The axios client and a `VITE_API_BASE` placeholder are wired up so plugging in `C:\inetpub\mml-api` later is a one-line change in `.env`.

## 6. Files removed / changed from starter

- `HelloWorld.vue` — deleted.
- `src/App.vue` — slimmed to `<router-view/>`.
- `src/main.js` — registers Pinia, router, ElementPlus, ElementPlusIconsVue, imports styles and `element-plus/theme-chalk/dark/css-vars.css`.
- `src/style.css` — replaced by `src/styles/index.css`.
- `vite.config.js` — created; adds the two unplugin auto-imports.
- `index.html` — title → "SCADA Dashboard", `<html class="dark">`.
- `.env.example` — `VITE_API_BASE=http://localhost/mml-api`.

## 7. Out of scope (future)

- Auth flow (login page, token handling).
- WebSocket / SSE live telemetry — scaffold uses polling stubs.
- Real chart data, alarm acknowledgement, role-based menus.
- i18n.
- E2E tests.

## 8. Definition of done

- `npm install` + `npm run dev` boots without errors.
- Visiting `/` shows the dark dashboard shell with sidebar nav, header with connection pill, and the Overview page populated with mock StatCards, one GaugeTile, and one TrendChart rendering with mock data.
- All 5 routes navigate via the sidebar and preserve the shell.
- Sidebar collapses below 960px viewport.
- No console errors or warnings.
