# Management blocks — implementation plan

Three new Live-grid tile types for the management board: **Loss meter**
(cost of defects / production lost in ฿), **Andon board** (machine status) and
**Loss waterfall** (where the output went). They bind to an existing datasource
(DS), detect their machines from the table, and are dropped onto a dashboard
from a palette.

Design was agreed in a grilling session on 2026-10-21. Decisions are numbered
D1–D15 and referenced from the steps below. Mockups were reviewed inline in that
session (vertical waterfall, size-adaptive Andon, Thai-first labels).

---

## Agreed decisions

| # | Decision |
|---|---|
| D1 | Blocks read **raw signals**; the server computes with a fixed formula per block type. Typed constants live in the panel's `options` — no new tables. |
| D2 | New `chart_type`s on the **existing Live grid** (`dashboard_panels`). A management board is just another dashboard. |
| D3 | **Named slots** per block, each its own binding to DS columns. |
| D4 | **No shift calendar.** Run/stop time is detected from the table; the period is a calendar range: `today` / `week` / `month`, from local midnight. |
| D5 | Speed threshold → **Run / Slow / Stop / No data**. Run ≥ `run_ratio` × target, Stop ≤ `stop_threshold` for ≥ `min_stop_sec`, No data = gap > 3× sample interval **or** a value outside `[0, valid_max]`. |
| D6 | `defect_*` (and `count_*`) are **rates per minute**: pieces in a row = value × interval ÷ 60. Negatives → 0, above `valid_max` → No data. |
| D7 | **One ฿ per rejected piece** (`cost_per_piece`). Production lost is valued at the same price. |
| D8 | Machines = **detected column families** (`CAM001-13`, …, same rule as `groupByFamily`). Slots are **suffix rules** (`speed` = `count_1`, `defects` = `defect_*`). Each block can exclude families. |
| D9 | **Target** = p95 of running speed over the trailing 7 days, per family (auto). A typed per-family value overrides it. The tile shows "auto"/"set". |
| D10 | A stop counts as **loss up to `max_loss_stop_min`** (default 120). Longer stops become **Not scheduled**. A stop still in progress under the cutoff shows as **pending**. Optional `working_hours` per block: inside them every stop is loss regardless of length. |
| D11 | First release: **Loss meter, Andon board, Loss waterfall**. Pareto, progress ring and pace bar come later. |
| D12 | Edit-mode **palette**: drag or click a card, and the tile is created **already bound** and live. Tweaks happen in a **non-modal side inspector**. The old modal stays for classic charts. |
| D13 | One **`GET /api/kpi/summary`** per binding, shared by all blocks with that binding. **1-minute SQL aggregation** on the plant DB, incremental in-memory cache, target recomputed hourly. Poll 60 s default, 30 s minimum. |
| D14 | New **`manager`** role. Managers and admins see ฿. For everyone else the server strips ฿ fields and `cost_per_piece`. |
| D15 | Live tile chrome (header, poll pill, gear) and theme tokens. Thai-first labels. The Andon board adapts its detail to the tile size (container queries). The waterfall is **vertical**. |

Defaults assumed during the session (not explicitly confirmed):

- `count_1` is pieces **inspected** (good + reject), so good = pieces − defects.
- "▲ vs previous period" compares **like-for-like elapsed time**: today up to
  14:30 vs. yesterday up to 14:30.
- Each `CAM00x-13` family is one machine tile.

---

## Calculation model (the contract every step implements)

All numbers come from **per-family minute buckets**. A bucket stores only
threshold-*independent* facts, so it stays valid when the target or ratios
change (only `stop_threshold` / `valid_max` are part of the cache key):

```
bucket = { minute, valid_s, stop_s, gap_s, speed_sum, speed_n,   -- speed slot
           pieces, defects }                                      -- integrated, pcs
```

- `valid_s` / `gap_s`: seconds covered by a valid row vs. not covered (a row
  covers `min(ts − prev_ts, 3 × nominal)`; anything beyond is gap).
- `stop_s`: valid seconds with speed ≤ `stop_threshold`.
- `speed_sum / speed_n`: mean speed over the valid, non-stopped rows.
- `pieces = Σ speed × covered_s / 60` and `defects = Σ Σdefect_k × covered_s / 60`,
  with clamping per D6.

The pure engine classifies each minute, in this order:

1. **No data**: `gap_s ≥ 30`.
2. **Stop**: `stop_s ≥ 30`.
3. **Run**: mean speed ≥ `run_ratio × target`.
4. **Slow**: otherwise.

`min_stop_sec` is then applied by merging Stop runs shorter than it into the
neighbouring state. Sub-minute stops are invisible by construction, which is
acceptable because the default `min_stop_sec` is 60.

Loss accounting per family over the period (minutes inside `working_hours`
when set):

- `stop_loss = Σ target` over Stop minutes that belong to a stop span counted
  as loss (span ≤ cutoff, or inside working hours). A span still open, ≤ cutoff
  and not inside working hours → its minutes go to `pending` instead.
- `slow_loss = Σ max(0, target − mean_speed)` over Slow minutes.
- `potential = pieces + stop_loss + slow_loss`. Potential is **derived** so the
  waterfall always balances: `potential − stop − slow − defects = good`.
- ฿ = pieces × `cost_per_piece` for each figure (stripped per D14).
- Comparison: the same engine over `[prev_start, prev_start + elapsed)`.

---

## Build order

Each step ends green (tests + build) and is committable on its own.
Backend first, because the frontend blocks render the `/api/kpi/summary`
response shape.

### Step 1 — Pure engine (backend, TDD)

**New** `scada-mml-backend/kpi_engine.py`: pure functions, no DB, no FastAPI.
It follows `production_log.py`'s shape.

- `classify_minutes(buckets, target, settings) -> list[state]`
- `merge_short_stops(states, min_stop_sec)`
- `stop_spans(states, minutes, now) -> [{start, end, open}]`
- `account_losses(buckets, states, spans, target, settings, now) -> {stop_loss, slow_loss, pending, pieces, defects, potential, good, minutes_by_state}`
- `p95_target(running_speeds) -> float | None`
- `strip_cost(summary) -> summary`, used for D14

**New** `tests/test_kpi_engine.py`. Write these cases first:

- Run / Slow / Stop / No data classification at the boundaries (30 s rules, `run_ratio` edge).
- A 40 s dip inside Run stays Run. A 90 s stop is a stop.
- A 54-min lunch stop counts as loss. A 16 h night stop is Not scheduled.
- An open 20-min stop → pending, not loss. Once it passes the cutoff → Not scheduled, and pending drops to 0.
- `working_hours` set: a 3 h breakdown inside them is fully loss.
- The waterfall balances exactly: `potential − stop − slow − defects == good`.
- No-data minutes contribute nothing to any loss.
- p95 ignores Stop/No-data minutes and returns `None` with fewer than 60 running minutes.
- `strip_cost` removes every `*_baht` key and `cost_per_piece`, recursively.

### Step 2 — Family detection parity (backend)

**New** `scada-mml-backend/name_families.py`, a straight port of
`scada-frontend/src/utils/nameFamilies.js` `groupByFamily`, plus
`resolve_slot(family, names, rule)` (exact suffix `count_1`, or glob `defect_*`).

**New** `tests/test_name_families.py`. Copy the JS test cases verbatim, so
the server and the Reports trend can never disagree about what a family is.
Add the real `sensor_log1` column list as a fixture (5 families plus
`Temparature1-4` ungrouped).

### Step 3 — Minute aggregation query (backend `db/`)

**New** `scada-mml-backend/db/kpi.py` (export through `db/__init__.py`,
add the names to `__all__`; `test_db_facade.py` enforces it):

- `kpi_minute_buckets(datasource_id, table, ts_col, families, start, end, stop_threshold, valid_max)`
  → one `SELECT` with `lag(ts)` for the covered interval and `date_trunc('minute')`
  `GROUP BY`. Array columns read `col[1]` (slot 0, the convention in `db/series.py`),
  scalars read as-is. Identifiers are composed with `psycopg.sql.Identifier` only,
  with column names validated against `describe_table(...)` before composing.
  Plant connection via `_table_source_conn(datasource_id)` (`db/tables.py`).
- `kpi_running_speeds(datasource_id, table, ts_col, speed_col, start, end, stop_threshold, valid_max)`
  → per-minute mean running speed, for p95.
- Set `statement_timeout` (e.g. 20 s) on these reads. A cold month over the VPN
  must fail loudly, not hang a worker.

**New** `tests/test_kpi_sql.py`: SQL composition (identifier quoting, `[1]`
for array columns, no f-string values). Live behaviour is verified in Step 11.

### Step 4 — Incremental cache (backend)

**New** `scada-mml-backend/kpi_cache.py`. Process-local, guarded by a `threading.Lock`:

- Key: `(ds, table, ts_col, family, stop_threshold, valid_max)` → `{minute: bucket}`.
- On a request, fetch only `[last_closed_minute − 2 min, now)`. The 2-minute
  overlap catches late rows. Replace those minutes, never append duplicates.
- The current (open) minute is never cached.
- Evict minutes older than 40 days. Cap the number of keys with LRU (e.g. 64).
- Targets: `(ds, table, family, speed_col)` → `(value, computed_at)`,
  refreshed when older than 1 h.

**New** `tests/test_kpi_cache.py` with `db.kpi_minute_buckets` patched:
- the second call asks only for the tail
- overlap replaces, it doesn't duplicate
- eviction
- target reuse inside the hour, refresh after it

### Step 5 — `manager` role (backend + frontend)

Backend:
- `users.py`: `VALID_ROLES = {"admin", "manager", "operator"}`.
  `register` still forces `operator`.
- `auth.py`: add `can_see_cost(user) -> bool` (admin or manager). Extend
  `require_operator_or_admin` to accept `manager`, so managers can change a
  tile's poll interval like operators. Its docstring claims there are two
  roles; update it.
- `panels.py` `list_panels`: for non-cost roles, drop `options.kpi.cost_per_piece`
  from KPI panels.

Frontend:
- `stores/auth.js`: add a `canSeeCost()` getter.
- `AccountsPage.jsx`: add `manager` to the role select and give it a distinct chip colour.
- `LivePage.jsx` `canChangePollInterval`: include `manager`.

Tests:
- extend the existing auth/users tests: create a manager, manager can patch the poll interval, manager can't create panels
- panel list strips the price for operators

### Step 6 — Panel model for KPI blocks (backend)

`panels.py`:
- `VALID_CHART_TYPES += {"lossmeter", "andon", "waterfall"}`.
- **`VALID_SOURCES += {"kpi"}`** with its own validator branch. The `table`
  branch requires `metric ∈ value_columns`, and the real Line 13 columns are
  `float8[]` (`array_value_columns`), so KPI panels must not go through it.
- KPI chart types require `source == "kpi"` and vice versa.
- Poll: KPI types accept `{30, 60, 600, 1800, 3600}` only (D13). Reject 5.
- New `_validate_kpi_options(options["kpi"], cols)`, strict whitelist:

```jsonc
"kpi": {
  "ts_col": "recorded_at",
  "location": null,                       // variables_tag.location narrowing
  "slots": { "speed": "count_1", "defects": "defect_*" },
  "exclude_families": [],
  "period": "today",                      // today | week | month
  "compare": true,
  "mode": "defects",                      // lossmeter only: defects | lost | total
  "cost_per_piece": 12,                   // >= 0, nullable
  "targets": { "CAM003-13": 7500 },       // overrides; absent = auto
  "run_ratio": 0.8,                       // 0.1–1
  "stop_threshold": 0,
  "min_stop_sec": 60,                     // 0–3600
  "valid_max": 50000,                     // > 0, required (filters ±2.78M glitches)
  "max_loss_stop_min": 120,               // 1–1440
  "working_hours": null                   // or { "start": "07:00", "end": "17:00", "days": [1,2,3,4,5,6] }
}
```

The panel's `table_name` + `datasource_id` carry the table. `metric` is set to
the first detected speed column, for back-compat with code that expects it.

Tests (`tests/test_kpi_panels.py`):
- each validation error
- a KPI type with `source=table` rejected
- poll 5 rejected
- a round trip keeps `options.kpi` intact

### Step 7 — `/api/kpi/summary` router (backend)

**New** `scada-mml-backend/kpi.py` with `router = APIRouter(prefix="/api/kpi", tags=["kpi"])`,
mounted in `main.py`.

`GET /api/kpi/summary?panel_id=…`. The server reads the binding from the
stored panel, so a viewer can't pass arbitrary tables or settings. It does
**not** take raw settings in the query. The inspector's unsaved preview uses
`POST /api/kpi/preview` (admin only), which takes the same `options.kpi` body
and validates it through Step 6's validator.

Response (`KpiSummaryOut`), one shape for all three blocks:

```jsonc
{
  "generated_at": "...", "period": { "start": "...", "end": "...", "elapsed_min": 870 },
  "families": [{
    "key": "CAM003-13", "label": "CAM003-13",
    "state": "stop", "state_since": "...", "run_pct": 64,
    "speed": 0, "target": 7480, "target_source": "auto",
    "strip": [{ "start": "...", "end": "...", "state": "run" }],   // 24 h, merged spans
    "pieces": 9120, "defects": 803, "stop_loss": 1490, "slow_loss": 310, "pending": 108
  }],
  "totals": { "potential": 61200, "stop_loss": 7450, "slow_loss": 2390,
              "defects": 4017, "good": 47343, "pending": 108, "lost": 9840,
              "baht": { "defects": 48204, "lost": 118080, "pending": 1300, "total": 166284 } },
  "compare": { "defects": 3759, "lost": 9310, "baht": { ... } },
  "unscheduled_min": 960,
  "cost_visible": true
}
```

The cache key is the binding (not the panel id), so three blocks with one
binding cost one aggregation. `strip_cost` is applied when
`can_see_cost(user)` is false. Errors: DS unreachable → 503 with the
`_detail(e)` first line (same style as `schema.py`). Table not allowed → 400.

Tests (`tests/test_kpi_router.py`, `db.*` patched):
- the operator response has no `baht` / `cost_per_piece` anywhere
- the manager response has them
- preview is admin-only
- unknown panel → 404, non-KPI panel → 400

### Step 8 — Frontend data layer

- **New** `src/api/kpi.js`: `fetchKpiSummary(panelId)` and `previewKpi(options)`,
  each documenting the response shape in a trailing comment.
- **New** `src/components/live/useKpiSummary.js`: `useQuery` keyed on
  `['kpi-summary', panel.id, refreshSignal]`, with `refetchInterval =
  poll_interval_seconds × 1000`. The draft panel from the inspector switches it
  to `previewKpi`, debounced 500 ms.
- **New** `src/components/live/kpiView.js` + `kpiView.test.js`, pure functions:
  - Thai state labels ("เดิน", "ช้า", "หยุด 12 นาที", "ไม่มีข้อมูล")
  - duration formatting
  - ฿ and piece formatting through `utils/numberFormat`
  - vertical-waterfall geometry (bar bottoms/heights, connector y, largest-loss flag)
  - comparison arrow and colour (for loss, ▲ is bad)
  - 24 h strip → percentage segments

  Register the test in the `npm test` script.

### Step 9 — The three blocks (frontend)

**New** folder `src/components/live/blocks/`:

- `LossMeter.jsx`:
  - big tabular numeral
  - `mode` defects / lost / total
  - "+ pending" chip
  - ▲/▼ vs previous
  - faint cumulative sparkline (ECharts via `EChart.jsx`, `lazyUpdate`)
  - shows pieces when `cost_visible` is false
- `AndonBoard.jsx`:
  - one tile per family
  - state colour from tokens (`--accent`-family vars in `styles/tokens.css`; add `--state-run/slow/stop/nodata` tokens there for every theme)
  - stopped tiles pulse slowly, disabled under `prefers-reduced-motion`
  - container queries: below 420 px it shows name + state only, from 420 px speed + run %, from 560 px the 24 h strip + legend
  - No data is grey, never red
- `LossWaterfall.jsx`:
  - vertical bars: ผลิตได้สูงสุด → หยุดเครื่อง → เดินช้า → ของเสีย → ของดี
  - dashed connectors
  - largest loss in danger colour and bold
  - footer states target source and cutoff
  - geometry from `kpiView.js`; plain DOM/CSS rather than ECharts, so it stays crisp at any tile size
- `Blocks.module.css`, tokens only. Thai copy through `src/i18n`.

`LivePanel.jsx`: for `source === 'kpi'` render the block and **skip**
`usePanelPolling`/`usePanelSeries` entirely (no wasted series fetch). Keep the
header, poll pill and gear.

`panelPayload.js`:
- add the 3 entries to `VIZ_TYPE_META`, flagged `group: 'management'`
- add `KPI_DEFAULTS` and `panelMinSize` floors:
  - Loss meter 4×5
  - Andon 6×5
  - Waterfall 6×9

### Step 10 — Palette, drop-to-create, inspector (frontend)

- **New** `src/pages/live/BlockPalette.jsx`:
  - in Edit Layout, a drawer listing management blocks first, then classic chart types
  - cards are `draggable` with `onDragStart` setting the type
  - click = add at `nextLayoutSlot`
  - keyboard-operable (Enter adds)
- `LivePage.jsx`:
  - `isDroppable={editMode && canManage}`
  - `droppingItem={{ i: '__drop__', w, h }}` from the dragged type's `panelMinSize`
  - `onDrop` → `createPanel(defaultKpiPanel(...))`
  - render the grid in edit mode **even when the dashboard has no panels**; today it only renders when `panels.length > 0`
  - classic types dropped from the palette still open `PanelEditorDialog`, pre-set to that type
- **New** pure `src/pages/live/kpiPayload.js` + test:
  - `defaultKpiPanel(type, { datasourceId, table, tsCol, layout, dashboardId })`
  - DS = `datasourceSelection` store primary
  - table/ts_col = most recent KPI panel on this dashboard
  - if none → the panel is created unbound and the inspector opens with the table picker focused
  - `buildKpiSavePayload(draft)`
- **New** `src/pages/live/KpiInspector.jsx`: MUI `Drawer` `variant="persistent"`, right, non-modal:
  - table / ts col / location
  - suffix rules
  - family checklist (from the summary's detected families)
  - period / compare / mode
  - ฿ per piece
  - per-family target (shows the auto value, can override)
  - run ratio, min stop, valid max, cutoff, working hours
  - edits drive a draft panel that the tile previews live; Save calls `updatePanel`, Cancel reverts
  - reuse `ParamFields.jsx` (add a `time` field type for working hours)

### Step 11 — Showcase simulator and verification data

**New** `scada-mml-backend/simulate_kpi_showcase.py`, modelled on
`simulate_alert_showcase.py`:

- creates `vision_data.zz_kpi_demo` on the local `mmldata` DS (569)
- column shape copies `sensor_log1` exactly: `recorded_at timestamp`, and
  `"CAM00{1-5}-13-count_{1-5}"` / `"-defect_{1-5}" float8[]` as
  `[value, 0, 10, -1]`, plus `Temparature1-4`
- backfills 8 days at 10 s (for p95) and appends live with `--follow`
- scripted scenarios, so every rule has a visible case:
  - CAM001 clean (~7,500/min)
  - CAM002 running slow
  - CAM003 54-min lunch stop + a 3 h breakdown on day −2
  - CAM004 short 40 s dips
  - CAM005 a 6-min data gap
  - every night idle 17:30–07:00
  - ±2.78M glitches and negative defect values sprinkled in
- `--drop` removes the table

**New** `scratchpad`-only `verify_kpi.py`, never committed: it recomputes
today's totals from raw rows in plain Python and diffs them against
`/api/kpi/summary`. Agreement to the piece is the acceptance bar for the engine.

### Step 12 — End-to-end check

1. `pytest` (backend), `npm test` and `npm run build` (frontend).
2. Run `backend-8089` + `frontend-5174-8089` from `.claude/launch.json`. New
   routes don't hot-reload on the hand-started :8088.
3. As admin, on a new "Management" dashboard:
   - drag all three blocks onto the grid
   - confirm they show numbers within one poll and that `verify_kpi.py` agrees
   - resize the Andon tile across its 3 density steps
   - set `working_hours` and watch the CAM003 breakdown move into loss
4. As a manager account: ฿ visible.
   As an operator: no ฿ anywhere, checked in the **network response**, not just the DOM.
5. Light and dark theme screenshots. Run with reduced motion (no pulse).
6. Point a copy of the dashboard at **Line 13 vpn** (850, `sensor_log1`) and
   compare a day against the Reports trend for the same columns.

---

## Open data questions (resolve before showing ฿ to the board)

1. **`count_1` == `defect_1` on CAM001** (21 Oct 17:33, `6.0` / `6.0` for many
   rows) and `defect_1` summing to **−32M** that day. Wiring/mapping fault or
   test data? Confirm with the camera/PLC side.
2. Meaning of array slots 2–3 (`10`, `-1`). The engine uses timestamp deltas,
   not slot 2, until slot 2 is confirmed to be the interval in seconds.
3. Line 13 **nameplate speed**, to confirm `count_1` ≈ 7,500 is pieces/min and
   to set typed targets.
4. Confirm each `CAM00x-13` is one machine. If the cameras are stations on one
   machine, the Andon board should show one tile for the line.

## Out of scope (later)

- Defect Pareto, progress ring, pace bar (D11 second wave)
- Kiosk/TV display mode for the Live page (D2)
- Per-defect-type or per-camera pricing (D7)
- A persisted rollup table, if the in-memory cold start proves too slow over the VPN (D13)
- A plant shift calendar, and replacing the hardcoded 08:00–18:00 in
  `production_log.py`, `mimic.py:431` and `SHIFT_HOURS`
- Real Fault state from a PLC state-code column (D5 alternative)

## Risks

- **Cold month over the VPN.** One aggregated query on about 260k rows × 30
  array columns. Measure it in Step 12.6. If it exceeds the timeout, prefetch
  month buckets in the background on first use and serve `today` first.
- **Multiple uvicorn workers** each hold their own cache, so the cost is N×
  cold queries. Acceptable now (single worker); revisit together with the
  persisted rollup.
- **Data quality decides credibility.** Ship to the board only after the open
  data questions 1–2 are answered. Until then, keep the Management dashboard
  admin-only.

---

## Implementation notes (2026-10-22)

Built as planned. These are the places where it differs, and the rules the real data forced:

- **Stop length is judged on the whole span, not the window.** `family_summary`
  classifies a context padded by `max_loss_stop_min + 1` on each side, so the
  night stop that began at 17:30 is still "not scheduled" one minute after
  midnight. The same applies to yesterday's comparison window.
- **The minimum stop length counts stopped seconds, not whole minutes.** A 40 s
  dip fills one Stop minute, so judging it as 60 s would have kept it as a stop.
- **The auto target comes from the cached minute buckets** (p95 of the running
  minutes' mean speed). No separate `kpi_running_speeds` query.
- **A new block inherits all of the newest block's loss settings** (targets,
  ratios, cutoff, working hours, price, period), not only the binding.
  Otherwise blocks on one board disagree: a target typed on the Andon board
  would leave the waterfall's "slow" figure at 0. The Loss meter's `mode`
  stays per block. Settings are still stored per block (D1), so editing one
  block later doesn't update its siblings.
- **The Loss meter sparkline is a plain SVG** built from successive polls (the
  summary carries totals only). No ECharts.
- **Labels go through `src/i18n`** (English keys, Thai messages), as everywhere else.
- **The Edit Layout grid keeps a minimum drop area**, so the first block can be
  dropped onto an empty board.
- Verified end to end against `vision_data.zz_kpi_demo`: per-family pieces and
  defects matched a raw-row recomputation to the piece, and the waterfall
  balances exactly. Operator responses carry no `baht` or `cost_per_piece`.

---

## Second set (2026-10-22): from the Line 13 monitoring dashboard

Source: `docs/Line13_Monitoring_Dashboard.html`. Line 13 is confirmed as **one line**.

- **`scope: "line"` (the default).** Output, run and stop come from one camera
  family's speed (`line_family`, defaulting to the first). Defects add up across
  every camera. Per-camera states stay available for the Andon board.
  `scope: "machines"` keeps the earlier behaviour.
- **New blocks.** `kpistrip`, `pace`, `hourly`, `sensors`, `response`,
  `kpitrend`, `pareto`. All of them read the same `/api/kpi/summary`. Sections
  only one block needs (timeline, sensors, incidents, trend, Pareto) are computed
  only for that block's `chart_type`.
- **Sensors read `[value, setpoint, high, low]`.** That's the plant's array
  layout, confirmed by the HTML, which answers open question 2.
  - A sensor minute is out of band, frozen (unchanged for `flat_min`, default 10),
    missing, or OK. Frozen outranks out of band.
  - Pieces at risk = line pieces made while any sensor was out or frozen.
  - Blind time = minutes where a sensor was frozen or missing while the line's
    own state was known.
- **Responses.** Each out-of-band incident (gaps of 3 minutes or less are merged)
  is paired with the first `event_logs` change on that tag within 4 hours. The
  owner comes from the response-role rules.
- **Plan.** `plan_pieces` covers the whole period. It's spread over working hours
  if they're set, otherwise linearly. "Good vs plan" compares against the plan to
  date.
- **Live grid fixes found while testing.** Board resolution and layout locking
  now wait for a *successful* load, and a react-grid-layout report that would
  drop every tile of the board on screen is ignored. Before this, a reload
  during the session refresh, or a late width update, could leave a board blank.
