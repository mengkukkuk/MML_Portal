# Monitor KPI strip — agreed design

Reference: `scada-frontend/example/line-monitor-dashboard_7.html`

## Premise corrections (established during grilling)

1. The three top boxes **do not exist** in MMLPortal. The strings
   `ผลิตได้วันนี้ / ของเสียวันนี้ / อัตราของเสีย` appear only in the reference
   HTML (lines 167–169). Screenshot 1 was the reference page. So item 1 is
   "build the strip and make it configurable", not "add a unit field".
2. The **hourly bar chart already exists** — `ProductionLogDrawer.jsx` renders
   stacked bars, hour labels, click-to-select readout, future-hour stubs and a
   60s refetch. The screenshot showed its *empty state*: `doc.productionLog` is
   unset on that mimic. Item 3 is a **configuration task, not code**.
3. Mimic symbols **do** honour a pinned `binding.datasource_id`, falling back to
   the header's primary only when unset (`useMimicPlant.js:43-47`). Per-box
   datasource pinning is therefore the house pattern and costs nothing.
   (`doc.productionLog` is the exception — `mimic.py:448-455` forces it to match
   the primary header selection.)

## Item 3 — hourly bar chart

No code. Configure the binding: **Edit layout → toolbar (bar-chart icon) →
Production Log dialog**. User confirmed the plant has one timestamped table with
two cumulative counters (good, reject), which is exactly the shape
`db.production_log_hourly` (`db.py:1739`) expects.

**Status: WALKED — DOES NOT FIT. Item 3 is backend work, not configuration.**

Walked against the live `MMLData` datasource (id 312) on 2026-09-12. The dialog
is reachable and works; the *data shape* is the blocker. Every table was checked:

| Table | Numeric columns offered as counters |
|-------|-------------------------------------|
| `counter_tag` | `location_no, flame, address_tag, value_tag, alarm_no, alarm_value` |
| `status_tag` | `value_tag, current_setpoint, setpoint, current_high_value, high_value, current_low_value, low_value, address_tag, alarm_value, alarm_no` |
| `pressure1log` | `value, setpoint, high, low` |
| `sensor_tag_scale1` | `scale_factor, scale_offset` |
| `sensor_log1`, `sku_machine`, `event_logs` | none |

The plant is **tag-per-row (EAV)**, not wide. `counter_tag` holds three
counters — `Counter1`, `Counter2`, `Counter3` — as *rows*, all sharing the one
`value_tag` column, with identity in `tag_name`. There is no `good_count` /
`reject_count` column pair anywhere on this source.

`ProductionLogDialog` requires two *distinct columns* in one row stream
(`producedCol !== rejectedCol`) under a **single shared** `filter_col`/
`filter_val`. Expressing "good = value_tag WHERE tag_name='Counter1', reject =
value_tag WHERE tag_name='Counter2'" is therefore not representable: the two
counters need different filter *values*, and the binding has room for only one.

### What would close it

Extend the binding with a per-counter filter value — keep the shared
`filter_col`, add `produced_filter_val` and `rejected_filter_val`, and relax the
`produced_col !== rejected_col` rule when they are present. `production_log_hourly`
(`db.py:1739`) then reads the two counter series separately on its existing
single REPEATABLE READ snapshot and aggregates each before zipping by hour.
Touches `db.py`, `mimic.py`'s `_validate_production_log`, and
`ProductionLogDialog.jsx`. The wide-table path stays exactly as it is.

### Original (now falsified) note "Counters exist" is a belief about the
data, not a confirmed read. Falsifying case: `ProductionLogDialog` needs
`producedCol !== rejectedCol`, both drawn from `columns.value_columns`, plus a
timestamp in `datetime_columns`. If the reject count lives in an `integer[]`
(as `camera_defect.defect_array` does in `sch_vision_data.sql`) rather than a
scalar column, it never appears in `value_columns`, the dialog cannot be
satisfied, and item 3 becomes backend work after all. **Action: walk the dialog
against the live datasource before reporting item 3 done.**

## Items 1 & 2 — the KPI strip

### Data model
- New `doc.kpis`: an **array of 0–6** box definitions. Variable list, not fixed
  slots — admin adds, removes and reorders.
- Each box carries a **stable generated id** assigned at creation (`kpi:<uuid>`),
  never a positional one. Reordering must not reassign which binding owns which
  poller id, or `keepPreviousData` flashes the previous box's value into the new
  slot.
- Each box is **independently bound** (not derived from the production log).
- A box shows the **latest value** of its bound column — `fetchSchemaLatest`,
  the same read every live symbol uses. **No backend read work.**
- A box's binding is stored in the **exact flat snake_case shape `argsOf` already
  consumes** (`useMimicPlant.js:78`): `table`, `value_col`, `ts_col`,
  `filter_col`, `filter_val`, `datasource_id`, `expr`. Verified — it then drops
  into the poller's `{ nodeId, b }` list unchanged, which is the entire reason
  riding the poller is cheap. If these shapes ever diverge, that cost estimate
  is void.
- Per-box fields: **binding, label, unit, decimals, value transform**.
  - unit: picked from `UNIT_GROUPS` (`@/utils/units`) with free-text fallback
  - transform: `compileExpr` (`@/utils/mathExpr`), same as Live panels/symbols
  - label: bilingual (Thai + English), per the app's `bilingual()` convention
- **Explicitly out of scope**: sub-caption text ("เป้ากะ 9,000"), thresholds and
  amber/red breach colouring. The reference's amber `2.20%` renders plain.

### Picker
A **trimmed SymbolBindingDialog** — keep Connection → Table → Column → Filter,
the column-kind grouping and badges, and the live value preview. Drop the
symbol-only parts: state maps, beacon colours, instrument bubble preview.

### Placement
Full-width strip under the page header **and** carried into `fullscreenHead`.
Fullscreen drops the page header, and a wall display is exactly when these
numbers matter most — the existing code already re-adds title/status there for
the same reason.

### Editing
Direct manipulation in Edit mode: click a box to open its dialog, `+` slot at
the end to add, drag to reorder, `×` to remove. The `+` slot is always present
so an empty strip still has something to click (cold start).

### View mode, unconfigured
**Collapses entirely** — no boxes, no strip, no reserved space. Every existing
mimic is untouched by this feature until someone configures it.

### Polling
KPI bindings feed into the existing **`useMimicPlant`** poller under synthetic
ids — the box's own stable `kpi:<uuid>`, not its position. They inherit the cadence control (`liveMs`), the
unreachable-after-3-ticks rule, transform/decimals handling and source-health
reporting. The strip can never show a different tick than the drawing beneath it.

### Validation — deliberate omission
**Frontend-only. No Python changes.** `_validate` (`mimic.py:281`) ignores
unknown doc keys and `upsert_mimic_layout` stores `body.doc` whole, so `doc.kpis`
persists as-is.

Mitigation: the dialog shows a **live value preview** before saving, which covers
the typo case.

**Accepted risk:** a binding that breaks *later* — column dropped, table renamed
— fails silently as a blank box, with nothing pointing at the cause. Every other
binding in the document gets a server-side check; this one will not.
Reversible later by adding a `_validate_kpis` pass alongside
`_validate_production_log`.


---

# Implementation notes (as built)

## Files

| File | Role |
|------|------|
| `scada-frontend/src/pages/monitor/kpiBoxes.js` | Doc helpers: `KPI_LIMIT`, `newKpiId`, `blankKpi`, `kpiIsBound`, `normalizeKpis`, `kpiPollNodes` |
| `scada-frontend/src/pages/monitor/kpiBoxes.test.js` | 11 tests, registered in `package.json`'s `test` script |
| `scada-frontend/src/pages/monitor/KpiStrip.jsx` + `.module.css` | The strip, view and edit |
| `scada-frontend/src/pages/monitor/KpiBindingDialog.jsx` + `.module.css` | Trimmed SymbolBindingDialog |
| `scada-frontend/src/pages/monitor/layoutDoc.js` | v3 → v4 migration adding `kpis: []` |
| `scada-frontend/src/pages/monitor/defaultLayout.js` | `LAYOUT_VERSION` 3 → 4, seed carries `kpis: []` |
| `scada-frontend/src/pages/monitor/MonitorPage.jsx` | Wiring: `pollNodes`, handlers, both render sites |

**Naming deviation from the spec:** the helper module is `kpiBoxes.js`, not
`kpiStrip.js`. On Windows `kpiStrip.js` and `KpiStrip.jsx` resolve to the same
path and the bundler refused the import. Anything added here must keep a name
that differs from a sibling component by more than case.

**`LAYOUT_VERSION` is now 4.** A doc saved by this build opens read-only in an
older bundle (`isFutureVersion` → `editLock`), which is the intended guard: an
older client must not save a document whose strip it cannot draw.

## Two bugs found by running it

1. **Page-killing crash.** `previewQuery.error?.response?.data?.detail` rendered
   straight into JSX. A plant fan-out failure answers with an *object*
   (`{error, sources}`), and React throws "Objects are not valid as a React
   child", taking the whole Monitor page down. Fixed by routing through
   `apiErrorMessage` (`src/api/client.js:94`). **`SymbolBindingDialog.jsx:834`
   has the identical line and will crash the same way** — filed as a follow-up
   task, not fixed here.
2. **Duplicate React key.** `UNIT_GROUPS` is not unique by value (`g` is both a
   gram and a g-force), so a flat datalist keyed on value warned on every
   render. Fixed with a `Map`-deduped `UNIT_OPTIONS`.

Also corrected during the browser pass: an unbound-but-never-read box said
"ข้อมูลเดิม / Last known", implying a figure that had once been real. Never-read
and went-stale are now distinct captions.

## Verified in the browser (admin, live `MMLData` datasource)

- Strip absent entirely on a mimic with no KPIs, view mode — no reserved space
- `+ Add number` appears in Edit mode; opens the dialog on add
- Table → value column list populates with type badges (`value_tag · int4`)
- Live preview read **255** from the plant; with unit `ชิ้น`, 0 decimals and
  expression `a / 10` it previewed **26 ชิ้น** — expression, rounding and unit
  all applied before saving
- Saved box rendered in the strip, ticked 26 → 25 → 0 across polls
- Persisted across a full reload
- Two boxes issue **one request each inside the same poll round** as the
  drawing's own symbol requests — confirmed in the network log, which is the
  whole claim behind riding `useMimicPlant`
- Remove box works from the dialog; layout saved back to zero KPIs

## Third bug: id repair on the render path

`kpis` was `useMemo(() => normalizeKpis(layout?.kpis), [layout])`, and
`normalizeKpis` mints an id for any box missing one. `layout` changes identity on
every `commitLayout`, so a document containing a malformed box would be handed a
**fresh id on every edit** — moving the poller's react-query key and discarding
that box's accumulated history each time an admin nudged an unrelated symbol.
The repair never reached the document either, so it would have repaired forever.

Split in two:
- `normalizeKpis` repairs and mints. Called **only** from `migrateLayout`, which
  is the page's single document boundary (server load, post-save, import,
  revision reload) — and now runs for every version, not only the v4 bump, so an
  imported v4 file with a duplicate id is fixed there too.
- `readKpis` is a pure read used by the render path: same output for any
  document that came through `migrateLayout`, but it *drops* an id-less box
  rather than minting.

Covered by five regression tests, including "reading the same document twice
yields identical ids".

## Reorder

Verified in the browser with two live boxes. Alt+ArrowLeft on box 2 moved it to
slot 1 and each value stayed with **its own label**: BOX TWO / 500 / `setpoint`
led, BOX ONE kept `value_tag` and went on ticking (250 → 280). No reading
migrated into a neighbouring box, which is the whole reason ids are generated
rather than positional.

## Not verified

**The full-screen banner copy.** `toggleFullscreen` uses the real Fullscreen API
(`stageRef.current?.requestFullscreen()`), which the embedded browser pane
blocks — the promise rejects and is swallowed. The `<KpiStrip inBanner />` inside
`fullscreenHead` compiles and its CSS exists, but it has not been seen on screen.
Press **F** on `/monitor` in a real browser to confirm.


---

# EAV (tag-per-row) production log — as built

## The binding gains two optional fields

`produced_filter_val` and `rejected_filter_val`. Their presence *is* the mode —
there is no separate `layout` field in the document, so an existing binding
opens as exactly what it has always been.

| | Wide (unchanged) | Tag-per-row (new) |
|---|---|---|
| counters | two distinct columns | one column, two tag values |
| `filter_col` | optional, shared | **required** — it names which counter a row is |
| `filter_val` | optional, shared | **must be null** |
| `produced_col == rejected_col` | rejected | normal |

## Backend

- `production_log.py` — extracted `_hourly_increments` (one counter) and
  `_envelope`. `aggregate_counter_samples` keeps its signature and semantics;
  new `aggregate_counter_series` reduces **two independent streams on their own
  baselines**. That independence is the point: the two tags are written by
  separate scans and never share a row, so zipping them by position would
  subtract a good count from whichever reject sample sorted beside it.
- `db.production_log_hourly` — branches on `per_counter`. Tag mode issues four
  reads (baseline + in-shift, per counter) on the **same REPEATABLE READ
  snapshot and the same captured plant clock** as before.
- `mimic._validate_production_log` — accepts the new shape and rejects the ways
  it can be wrong: one tag named without the other, both counters on one tag,
  per-counter tags without a `filter_col`, and a shared `filter_val` combined
  with per-counter tags (which would narrow both series to one tag and leave the
  other empty — silently, with a plausible-looking chart).

## Frontend

`ProductionLogDialog` gains a **Counter layout** select. In tag mode the reject-
column picker is replaced by one *Counter column*, the filter picker becomes
*Tag column*, and two tag inputs appear (datalist-backed from
`/api/schema/values`). The preview reads **each side under its own tag**, so two
different figures prove the filter is really discriminating.

## Tests

10 new backend tests (20 in `test_production_log.py`, 410 in the suite). Two pin
the generated SQL: tag mode must issue four reads, all selecting one `AS value`
column, all filtered by the tag column, with params
`[Counter1, Counter1, Counter2, Counter2]`, and must read the plant clock exactly
once. A third pins that the wide layout still reads both counters from one row
stream. The failure these guard against is silent — a wrong binding still
renders a chart.

**Pre-existing, unrelated:** `tests/test_datasource_conn.py` has 2 failures on a
clean tree (verified by stashing).

## Verified in the browser

Against live `MMLData`, `counter_tag`, `value_tag` + `tag_name`:
- Layout select defaults to Wide; switching to tag mode swaps the fields
- Same tag for both counters disables Save (frontend guard)
- `Counter1` / `Counter2` previewed **good 21, reject 0** — two different
  readings from one column, told apart only by tag

## Not verified — needs a backend restart

The save and the rendered chart. `main.py` runs uvicorn with no reload
(`main.py:464`), so the instance on :8088 still holds the old validator and
answered the save `PUT /api/mimic/layouts/camera-test` with **400**. That 400 is
itself the confirmation that the frontend sends the new shape. Restart the
backend, then save the binding and open LOG.
