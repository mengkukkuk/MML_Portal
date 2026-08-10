# Monitor page — bind each symbol to a real data source

## Context

`/monitor` (`scada-frontend/src/pages/monitor/`) draws a P&ID-style mimic of Boiler House 1.
It looks finished but it is a drawing of a plant that does not exist: every value comes from
the in-browser simulator in `components/mimic/mockPlant.js`, and the layout lives in one
browser's localStorage. The header says so out loud — *"simulated process · no datasource"*.

Meanwhile `/live` already solves the hard half of this problem end to end. A Live panel binds
to any table/column on the app DB **or on any saved connection** (`datasources` table), and
`db._table_source_conn()` opens a real libpq connection to that external Postgres at poll time.
The whole `/api/schema/*` surface — tables → columns → distinct values → latest → series — is
built, admin-gated, identifier-allowlisted, and proven in production by the Live grid.

This change makes each mimic symbol an actual monitoring device: an admin clicks a symbol,
picks a connection → table → column → device row, sets how it should read (unit, decimals,
range, alarm limits), and the symbol animates from live plant data. Bindings are saved
server-side so every operator sees the same commissioned plant. `mockPlant.js` survives behind
an explicit **Demo data** toggle.

Per-symbol `datasource_id` means one mimic can span several backends — a boiler on one
historian, a conveyor on another — which is the point of reusing the saved-connections list.

## Decisions taken

| Question | Decision |
|---|---|
| Persistence | Postgres `mimic_layouts` table + `/api/mimic` router, admin-gated writes (mirrors `/live`) |
| Run/stop state | Derived from the numeric value (threshold or 0/1/2 map). **No backend change** — `/api/schema/latest` returns `float`, so text/boolean state columns are out of scope this pass |
| Unbound symbols | Render "not connected"; `mockPlant.js` stays behind a **Demo data** header toggle |
| Polling | One page-level poller, not one query per symbol (see below) |
| Cascade resolver | Written fresh for the single-series case — **do not** extract `PanelEditorDialog`'s `applyBinding` |

**Why one page-level poller.** Not for request dedupe — two symbols rarely share a binding.
The snapshot is *coherent by construction*: `createPlantSim.tick()` computes `prev`/`pulse`/
`events` across all tags in one pass, `MonitorPage.jsx:57` reduces `plantStatus` with
`worseStatus` over every tag, and `DetailRail` filters one shared `events` array. Independent
per-symbol queries cannot produce a coherent plant status or event log without a coordinating
layer anyway.

**Why not extract Live's cascade.** `applyBinding` (`PanelEditorDialog.jsx:159-223`) is
multi-series — `value_cols[]`, `filters[]`, plus unit/gaugeSeries pruning. A symbol is one
device on one row. The single-series cascade is ~40 lines written fresh: less code than the
extraction, and zero regression risk on the app's busiest page. Note the duplication as a
follow-up if it ever bites.

---

## Backend

### 1. `db.py` — `mimic_layouts` table

Add `init_mimic_table()` next to `init_datasources_table()` (`db.py:927`), plus
`get_mimic_layout(slug)`, `list_mimic_layouts()`, `upsert_mimic_layout(slug, name, doc)`.

```sql
CREATE TABLE IF NOT EXISTS mimic_layouts (
    id         SERIAL PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,          -- 'boiler-1'
    name       TEXT NOT NULL,
    doc        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

The whole layout document goes in `doc` as JSONB. Nodes, edges, ports and geometry have no
query needs, and the frontend document is already flat and serialisable — `layoutStorage.js:9-11`
was written for exactly this swap. Add `mimic_layouts` to `SENSITIVE_TABLES` (`db.py:699`) so a
layout can never be charted back through the generic table source.

### 2. `mimic.py` — new router (`/api/mimic`)

Model on `panels.py` / `datasources.py`: `get_current_user` for reads, `require_admin`
(`auth.py:141`) for writes.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/mimic/layouts` | user | `[{slug, name, updated_at}]` |
| GET | `/api/mimic/layouts/{slug}` | user | `{slug, name, doc, updated_at}`; **404** → client uses the seed |
| PUT | `/api/mimic/layouts/{slug}` | admin | Upsert whole doc, returns saved |

`_validate(doc)` mirrors `panels._validate` (`panels.py:88-183`): cap node count (256), require
every `node.type` to be a known symbol, and for every node carrying a `binding`, confirm
`db.get_datasource(binding.datasource_id)` exists and that `value_col` / `ts_col` / `filter_col`
appear in `db.describe_table(table, datasource_id)`'s respective lists. **Memoise
`describe_table` per `(datasource_id, table)` inside one request** — a 30-symbol save would
otherwise open 30 libpq connections to an external host.

### 3. `main.py`

`app.include_router(mimic.router)` after `datasources` (line 50) and `db.init_mimic_table()` in
the startup block (line 62).

---

## Frontend

### 4. Node shape — `binding` replaces the mock `tag` string

`node.tag` is currently both a mock-dictionary key and the id printed in the ISA balloon. Split it:

```js
{
  id: 'n-tank', type: 'tank', label: 'T-100 condensate',
  tagId: 'LT-100',                  // display only — the loop number in the balloon
  x, y, w, h, rot,
  binding: null | {
    datasource_id: null,            // null = app database
    table: 'sensor_readings',
    value_col: 'value',
    ts_col: 'ts' | null,
    filter_col: 'device_name' | null,
    filter_val: 'Boiler feed pump A' | null,
    expr: '',                       // utils/mathExpr.js, e.g. 'value/10'
    unit: '%', decimals: 1,
    range: [0, 100],                          // Gauge sweep + DetailRail ladder
    limits: { warnLo, warnHi, critLo, critHi },   // any may be null
    state: null | { mode: 'threshold'|'map', runAbove: 0.5, invert: false,
                    map: { 0: 'green', 1: 'amber', 2: 'red' } },
  },
}
```

Display config is **required work, not polish**: `Gauge.jsx` maps the needle across `tag.range`
and draws its alarm bands from `tag.limits`, `DetailRail`'s ladder needs `range`, and
`formatValue` needs `decimals`. Reuse `UNIT_GROUPS` (`utils/units.js`) and `compileExpr`/
`applyExpr` (`utils/mathExpr.js`), but write the four-sided `limits` shape as the mimic's own —
Live's `options.gaugeSeries` is single-sided `{min,max,decimals,warn,crit}` and does not fit.

**Migration, not reseed.** Bump the doc `version` 1 → 2. `layoutStorage.js:18-22`'s `isValid()`
only checks `id`/`type`/`x`/`y`/`w`/`h`, so a stored v1 doc would load clean into code expecting
`binding` and silently break. Write `migrateLayout(doc)`: `tag: 'LT-100'` → `tagId: 'LT-100',
binding: null`, geometry preserved. Run it on any v1 doc from the server **and** on the
localStorage doc during the one-time handover below.

### 5. `src/api/mimic.js` replaces `layoutStorage.js`

`fetchMimicLayout(slug)`, `saveMimicLayout(slug, name, doc)`. Server is the source of truth.
On load: GET → 404 falls back to `cloneDefaultLayout()`. **One-time handover:** if the server
has no row and a v1 localStorage doc exists, migrate it and use it as the starting document, so
an admin's hand-arranged drawing survives; clear the key after the first successful save.
Delete `layoutStorage.js` once `MonitorPage` no longer imports it.

### 6. `useMimicPlant.js` — the real poller

New `src/components/mimic/useMimicPlant.js`. **One TanStack `useQuery` per `datasource_id`**,
each keyed on a stable hash of that backend's node bindings + a `refreshSignal`, merged into one
snapshot before deriving. `refetchIntervalInBackground: true` — a wall display must not freeze in
a hidden tab.

Bucketing by backend is the price of the coherent snapshot, paid deliberately:
`_table_source_conn` uses `connect_timeout=5` and `Promise.allSettled` settles with the slowest
call, so a single unreachable historian in one shared query would add ~5s to every tick,
app-DB symbols included. Per-backend queries keep coherence where it matters and stop a dead
host stalling the boiler — the honest shape for a page that spans backends by design.

`pollSeconds` drives `refetchInterval` only and stays **out** of the query key
(`usePanelPolling.js:268-275` deliberately keys on binding fields + `rangeMinutes` +
`refreshSignal`); include it and every cadence change re-seeds all history from scratch.

- **Seed** (per binding-set change, not per tick): bindings with a `ts_col` get
  `fetchSchemaSeries` for the sparkline window via `Promise.allSettled`; bindings without one
  start empty and accumulate. Follow `usePanelPolling.js:121-180`, including the
  stale-source fallback to `fetchSchemaLatest` when the window is empty.
- **Poll:** `Promise.allSettled(fetchSchemaLatest(...))` per binding — one failure must never
  blank the mimic. Reuse `trimWindow` (`usePanelPolling.js:14-18`) and the "no `ts_col` →
  sample at wall-clock" rule (`usePanelPolling.js:84`).
- **Derive** in a pure `src/components/mimic/deriveTag.js`: `applyExpr` → `display` (round to
  `decimals`) → `state` (from `binding.state`) → `status` (from `limits`) → `pulse` (increment
  in a ref when `display` or `state` changes) → `events` (push `{ts, tag, from, to}` on status
  transitions, newest first, keep 30). Emit `status: 'stale'` when the row timestamp is older
  than 3 × poll interval — `DetailRail` and the symbols already style `stale`; nothing emits it today.
- Lift `analogStatus` and `worseStatus` out of `mockPlant.js` into a shared
  `src/components/mimic/tagStatus.js` so demo and live share one status implementation.
- **Output the exact `useMockPlant` snapshot shape** — `{ tags, history, events, ts, running }` —
  but keyed by `node.id` rather than tag id (two symbols may legitimately watch the same loop).
  Each entry keeps `id: node.tagId ?? node.id`. This also collapses `selectTag`
  (`MonitorPage.jsx:67-71`) into `selectNode` — the `n.tag === tagId` reverse lookup goes away.

**Cadence and history window stay client-side.** The cadence buttons are ungated today
(`MonitorPage.jsx:155-167`) — every user can change them. Persisting `pollSeconds` in an
admin-only PUT doc would silently demote operators, so cadence remains local component state:
it is a view preference, not plant configuration. (Live faced the same fork and answered it with
a narrow `require_operator_or_admin` PATCH, `panels.py:242` — that is the alternative if cadence
ever needs to be shared.) The sparkline window is likewise a local `HISTORY_MINUTES = 30`
constant feeding `fetchSchemaSeries(minutes)`, roughly matching the simulator's 120-point history.

### 7. `usePlantData.js` — one switch for demo vs live

Hooks can't be conditional, so a small wrapper calls both and returns the active one: pass
`enabled: false` to the live query in demo mode, and `tickMs: null` to `useMockPlant` in live
mode (small edit to stop its `setInterval`). It also remaps the simulator's tag-id-keyed
snapshot onto node ids via `node.tagId`, so `MimicCanvas` sees one shape either way.

### 8. Binding UI — the click path

Requirement 2 is literally *"clicking on the symbol to choose data source"*, but edit mode
currently **replaces** `DetailRail` with `SymbolPalette` (`MonitorPage.jsx:209-218`) — there is
no per-node inspector on the click path. Fix it in the rail:

- Edit mode rail = `SymbolPalette` when nothing is selected, **node inspector** when a node is.
  The inspector shows label, tag id, and a binding summary card — either
  `sensor_readings · value · Pump A` with an **Edit connection** button, or **Not connected**
  with a **Connect data source** button. Double-clicking a symbol on the canvas opens the
  dialog directly.
- Read-only mode: `DetailRail` gains an admin-only "Connect data source" affordance for a bound
  or unbound selected symbol, so an admin never has to enter edit mode just to rebind.

**`SymbolBindingDialog.jsx`** (new, `src/pages/monitor/`):

- **Signal** column — Connection (`datasources` + "Default (app database)") → Table → Value
  column → Timestamp column → Filter column → Device row. Same cascade *shape* as
  `PanelEditorDialog`, written fresh for one series: resolve each level against
  `fetchSchemaColumns`/`fetchSchemaValues`, clamp every field to a valid option, cache columns
  per `${dsId}::${table}`.
- **Guard:** when the table has no `ts_col`, require `filter_col` + `filter_val` — `table_latest`
  (`db.py:865-875`) does `LIMIT 1` with no `ORDER BY` and would return an arbitrary row. Live
  gets away with this because it charts many series; a symbol is one device.
- **Presentation** column — label, tag id, unit (`UNIT_GROUPS` picker), decimals, range min/max,
  warn lo/hi, crit lo/hi, expression.
- **State** section — only for symbol types whose registry `binding` is `both` or `discrete`
  (`symbols/index.js`). Threshold mode (`run` when value > x, invertible) covers pumps, motors,
  valves, conveyors, dampers; map mode (0/1/2 → green/amber/red) covers the stack light.
- **Live preview** — one `fetchSchemaLatest` on every binding change, rendered as the **actual
  symbol component plus its ISA balloon**, drawn by the same code the canvas uses. Binding
  becomes a WYSIWYG act rather than form-filling; this is the dialog's signature and the reason
  it should not look like a generic MUI form. Set it as an instrument datasheet: two titled
  columns, tag id and every numeric field in the same monospace as the balloon, hairline rules,
  `tokens.css` variables only so it survives all three faceplates.

### 9. Canvas + page

- `MimicCanvas.jsx`: `tags[node.tag]` → `tags[node.id]`. An unbound node draws at reduced
  opacity with a dashed hairline outline and an empty balloon — the drawing convention for an
  uncommissioned loop, and honest at a glance.
- The bottom strip iterates `layout.nodes` instead of `TAG_IDS`, labelled by `tagId ?? label`.
- Header: subtitle reflects real state (`3 of 17 symbols connected · 2 connections`), a
  **Demo data** toggle, and cadence buttons that offer **5s / 30s / 1m** in live mode (Live
  enforces a 5s floor server-side and there is no connection pool — `_table_source_conn` opens a
  fresh libpq handshake per call). Keep 1s/2s/5s in demo mode.
- **Simulate excursion** (`MonitorPage.jsx:169-176`, `EXCURSION_TAG = 'TT-202'`) only drives
  `simRef.current.excite()` — hide it whenever Demo data is off, where it would do nothing.
- Copy: "Not connected", "Connect data source", "Reading —", "Connection error — retrying…"
  (matching `usePanelPolling`'s existing wording).

---

## Files

**New:** `scada-mml-backend/mimic.py`; `scada-frontend/src/api/mimic.js`,
`src/components/mimic/useMimicPlant.js`, `deriveTag.js`, `tagStatus.js`,
`src/pages/monitor/SymbolBindingDialog.jsx` (+ `.module.css`), `NodeInspector.jsx`,
`usePlantData.js`.

**Modified:** `scada-mml-backend/db.py`, `main.py`; `src/pages/monitor/MonitorPage.jsx`,
`MimicCanvas.jsx`, `DetailRail.jsx`, `defaultLayout.js`;
`src/components/mimic/mockPlant.js` (export status helpers), `useMockPlant.js` (accept `tickMs: null`).

**Deleted:** `src/pages/monitor/layoutStorage.js` (after the handover path lands).

**Untouched:** everything under `src/pages/live/` and `src/components/live/`.

---

## Verification

1. Backend: `.\venv\Scripts\python.exe main.py`, then `.\venv\Scripts\python.exe simulate_data.py --seed`
   so `public.sensor_readings` has real rows to bind to.
2. Frontend: `npm run dev`, open `/monitor` via the Browser tools as an admin.
3. Fresh load with no server row → seeded drawing, all symbols "not connected", Demo toggle off.
4. Edit layout → select the tank → **Connect data source** → app database → `sensor_readings` →
   `value` → `ts` → `device_name` → a device. The preview balloon shows a real number before saving.
5. Save, exit edit mode: the symbol animates from live data, the sparkline seeds from history,
   `DetailRail` shows the ladder against the configured limits.
6. Bind a second symbol to a **saved connection** (Settings → Data sources) and confirm both
   poll independently against different backends; check `read_network_requests` for
   `/api/schema/latest?...datasource_id=` calls at the configured cadence and nothing faster.
7. Reload in another browser profile as a non-admin → same bindings, same values, no edit affordances.
8. Break one binding (rename the column) → that symbol alone goes stale/error; the rest keep running.
9. Set a tight `warnHi` → symbol turns amber, an event lands in the rail, plant status escalates.
10. Toggle **Demo data** → the whole seeded plant animates again; toggle back → live values return.
11. All three themes, `prefers-reduced-motion`, and keyboard focus on the new dialog.
12. `.\venv\Scripts\python.exe -m pytest tests/` for the backend.

## Follow-ups (not this pass)

- Text/boolean state columns — needs `/api/schema/latest`'s `value: float | None` widened.
- Interactive pipe/edge authoring; multi-plant switching.
- A batched `/api/mimic/values` endpoint if per-symbol polling proves heavy without a pool.
- Reconciling the single-series cascade here with `PanelEditorDialog`'s, if the duplication bites.
