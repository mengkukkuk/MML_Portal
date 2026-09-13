# Dashboard Dev Guide — ECharts Parameter Tuning (Expert Level)

How the Live dashboard renders charts, and exactly which knobs to turn to change
their behaviour. This is the deep-dive reference for `LivePanel` —
the Grafana-style single-tile renderer at
`scada-frontend/src/components/live/LivePanel.jsx`. Charts are rendered via the
generic `EChart` wrapper (`src/components/charts/EChart.jsx`) using the raw
`echarts` npm package. The simpler multi-series line chart on Overview/Trends
(`TrendChart`) follows the same option-builder idioms.

> **Library:** [Apache ECharts 6](https://echarts.apache.org/en/option.html) via
> the raw [`echarts`](https://www.npmjs.com/package/echarts) npm package.
> The canonical reference for every option key below is the ECharts **Option**
> docs — when in doubt, search the option name there.

---

## 1. The render pipeline in 30 seconds

```
panel (DB row)  ──▶  usePanelSeries()  ──▶  usePanelPolling()  ──▶  seriesList
       │                                                                │
       │                                                                ▼
   chart_type ───────────────────────▶  buildGenericOption()  ──▶  <EChart option>
   options (JSONB)                        (dispatches to viz-type builders in options/)
```

Key facts that govern everything else:

- **`panel.chart_type`** selects which option builder runs via `buildGenericOption()`.
  `'line'` is normalised to `'timeseries'` by `normalizeVizType()` in `usePanelSeries`.
- **`panel.options`** (a JSONB blob, exposed as `opts`) carries every tuning
  parameter. **This is the object you edit to adjust a chart.** All keys are
  optional with sane fallbacks.
- **`usePanelSeries` hook** extracts the panel's source (device|tag|table), expands
  the cartesian (value columns × filter values), compiles the math transform, and
  memo-izes stable series specs for polling.
- **`usePanelPolling` hook** wraps TanStack Query to fetch/accumulate points and
  latest values on the configured poll interval.
- The `option` object is built fresh on each render when `seriesList` changes (via
  a `useMemo` inside `LivePanel`). React's strict mode may mount/unmount the
  `<EChart>` twice during dev; the wrapper handles this by calling
  `echarts.getInstanceByDom(el) ?? echarts.init(el)` and disposing cleanly.
- `<EChart>` owns a `ResizeObserver` on its container and calls `chart.resize()`
  as needed; you never call it manually.

### ECharts import strategy — full bundle, no tree-shaking gotcha

`EChart.jsx` imports the full echarts bundle (`import * as echarts from 'echarts'`),
so the old tree-shaken-imports gotcha is **gone**. Every chart type, component, and
feature is available out of the box — there's no "silently blank if not registered"
failure mode to watch for. This simplifies code at the cost of a slightly larger
bundle, which echarts already optimizes via tree-shaking on its own side.

---

## 2. The `panel.options` knob reference

Every field below lives under `panel.options`. They are read by the viz-type builder
functions in `src/components/live/options/` and passed as `opts` (the second parameter).
Grouped by what they affect.

### Universal

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `decimals` | int | `null` (raw) | Digits after the decimal in every formatted value. Used by `fmtValue()` in shared.js, tooltips, labels, table cells. |
| `mathExpr` | string | `''` | Safe per-reading transform applied at data binding time (in `usePanelSeries`). Grammar: `value`, `+ - * / ^`, `abs sqrt pow min max floor ceil round`. e.g. `value/10`, `pow(value,2)`. No `eval`/`Function`. |
| `transform` | string | `''` | Alias for `mathExpr` (either name works). |
| `warn` / `crit` | number | `null` | "value ≥" thresholds. Colour escalation via `thresholdColor()` (shared.js): base → amber `#e6a23c` → red `#f56c6c`. Used by stat, bargauge, gauge. |

### Time series (`timeseries` / legacy `line`) — `timeseries.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `smooth` | bool | `true` | Spline smoothing. Set `false` for sharp step-free polylines. |
| `lineWidth` | int | `2` | `lineStyle.width` in px. |
| `area` | bool | `true` | Gradient area fill under the line. Auto-disabled when multi-series (muddy when stacked). Set `false` to force off. |

### Bar — `bar.js`

Inherits the universal knobs; bars use `colorAt(i)` and a 2px top border radius.
No bar-specific options yet.

### Bar gauge — `barGauge.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `min` / `max` | number | `0` / `100` | Value-axis bounds. |
| `orientation` | `'vertical'`\|other | horizontal | `'vertical'` swaps category/value axes (bars grow up instead of right). |

### Histogram — `histogram.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `buckets` | int ≥ 2 | `20` | Number of equal-width bins across the shared `[min,max]` of all series. X-axis label interval auto-thins to ~8 ticks. |

### Pie / Donut — `pie.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `donut` | bool | `true` | Donut hole on/off. `false` ⇒ solid pie (`inner = '0'`). |
| `innerRadius` | int (%) | `50` | Donut hole radius as a percentage. Outer radius is fixed `'72%'`. |
| `labelPosition` | `'outside'`\|`'inside'`\|`'center'`\|`'none'` | `'outside'` | Slice label placement; `'none'` hides labels. |

### Heatmap — `heatmap.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `bucketMinutes` | int | `5` | Time-bucket width (min 60s enforced). Cell colour = **average** value in bucket. |
| `colorMin` / `colorMax` | number | data range | Pins the `visualMap` domain so colours stay stable across refreshes. The colour ramp is green→amber→red. |

### Scatter — `scatter.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `pointSize` | int | `6` | `symbolSize` per point; marker opacity fixed at 0.75. |

### State timeline — `stateTimeline.js`

Custom-rendered Gantt bands (`type: 'custom'` + `renderItem`).

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `roundValues` | bool | `true` | Round values to int when deriving discrete states. `false` uses precision from `decimals` instead — more distinct states. |

Band height is the `BAND_H = 22` constant in the builder; change it there, and the tile
auto-heights accordingly.

### Candlestick — `candlestick.js`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `bucketMinutes` | int | `5` | OHLC aggregation window (min 60s). Open=first, Close=last, Low/High=min/max in bucket. |

### Gauge (radial) — `gauge.js`

Rendered as **small multiples** — one radial gauge per series.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `min` / `max` | number | `0` / `100` | Gauge sweep range (shared across all series in the panel). |
| `warn` / `crit` | number | `null` | Build the coloured `axisLine` stops (base → warn → crit zones). |
| `gaugeSeries` | object | `{}` | Per-series overrides: `gaugeSeries[unitKey] = {min, max, decimals, warn, crit}`. Any field left unset falls back to the panel-wide value. |

### Stat & Table (non-ECharts DOM, for completeness)

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `sparkline` | bool | `true` | Stat tiles show a mini line chart (`buildStatSparklineOption()`); single-series only. |
| `maxRows` | int | `10` | Table source: max recent rows rendered. |
| `value_cols` / `filters` / `tags` | array | — | Data-binding multipliers (see §5), not visual knobs. |

---

## 3. Shared style fragments — change the look in one place

These helpers live in `src/components/live/options/shared.js` and are reused across
most builders. Edit them once to restyle every chart consistently:

- **`legendCfg(isMulti)`** — scrollable legend, only shown when multi-series. Tune
  `fontSize`, `itemWidth/Height`, `top` here.
- **`gridTop(isMulti)`** — top padding (30 when legend present, else 12). The rest
  of the grid (`right/bottom/left`) is set per builder; bump `left` if Y-axis
  labels clip.
- **`timeAxis()` / `valueAxis()`** — the dark-theme time/value axes. Axis colours
  (`#8a99b3` labels, `rgba(255,255,255,0.06)` split lines) live here.
- **`tooltipAxis(seriesList, decimals)`** — axis-trigger tooltip with the
  `valueFormatter` that appends `unit`. Per-series/item tooltips (pie, scatter,
  heatmap, candlestick, state) use a bespoke `formatter` inline because they
  need custom layout.
- **`thresholdColor(value, baseColor, warn, crit)`** — applies warn/crit colouring.
- **`fmtValue(v, decimals)`** — formats a value to fixed decimals or as-is.

The dark palette constants: panel bg `#172238`, fg `#e6edf7`, muted `#8a99b3`,
warn `#e6a23c`, crit `#f56c6c`. Series colours come from `SERIES_PALETTE`
(`src/utils/seriesPalette.js`) via `colorAt(i)` (wraps after 10 series). The
editor previews use the **same** palette so swatches match the chart.

---

## 4. Recipes — common "leet" tweaks

### Add a brush/zoom (dataZoom) to time-series
Since echarts is imported in full (`import * as echarts from 'echarts'`), dataZoom
is always available. Modify `timeseries.js`:

```js
dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }],
```

Then bump `grid.bottom` to make room for the slider.

### Pin the Y-axis to a fixed range
`valueAxis()` uses `scale: false` (no auto-scale). For a fixed range on a specific
builder, override after spreading:
```js
yAxis: { ...valueAxis(), min: 0, max: 100 }
```

### Stack multiple bar/line series
Add `stack: 'total'` to each series object in `bar.js`/`timeseries.js`.
Note: area fills are intentionally dropped for multi-series lines — re-enable
with care, stacked translucent areas read as mud.

### Add threshold guide lines (markLine)
Per series (or one series), in any builder's series array:
```js
markLine: { silent: true, symbol: 'none', data: [
  opts.warn != null && { yAxis: opts.warn, lineStyle: { color: WARN_COLOR } },
  opts.crit != null && { yAxis: opts.crit, lineStyle: { color: CRIT_COLOR } },
].filter(Boolean) }
```

### Performance for high-frequency series
- Time-series with thousands of points: add `large: true` + `largeThreshold: 2000`
  to the line series, and keep `showSymbol: false` (already the case after 1 point).
- Polling already trims to the panel window via `usePanelPolling()` with
  `panel.window_minutes`, so the point count is bounded by window ÷ poll interval.
- Prefer `sampling: 'lttb'` on the line series for downsampled rendering of dense data.

### Custom renderItem (like state timeline)
The state timeline (`stateTimeline.js`) is the reference for `type: 'custom'`:
read encoded values via `api.value(i)`, map to pixels with `api.coord([...])`,
return a shape (`rect` here). Mirror this for waterfall/range/annotation visuals.

---

## 5. Data binding (so visuals have something to draw)

Series specs are derived in `usePanelSeries()` (`usePanelSeries.js`). One entry per
output series:

- **`source: 'tag'`** — `options.tags[]` (or single `tag_name`) → one series each,
  `metric` is the numeric column from `public.variables_tag`. No native history →
  starts empty, accumulates per poll, sampled at wall-clock so steady values still
  advance.
- **`source: 'table'`** — cartesian of `options.value_cols[]` × `options.filters[]`
  (with `filter_col`). With a `ts_col` it seeds real history; without one it behaves
  like the tag source.
- **`source: 'device'`** — single series from `device_id` + `metric` on
  `public.sensor_readings`.

The `buildSeriesList()` helper hydrates each spec with its `color` + `points` +
`latest` for the renderers. `isMulti` (≥2 series) drives legend visibility, label
chips, area-fill suppression, and gauge/heatmap sizing. Each point is
`[epochMs, value]`.

> Backend note: valid `chart_type` values are validated in
> `scada-mml-backend/panels.py`. **A new viz type needs three coordinated edits:**
> (1) the backend allow-list, (2) a new builder file + entry in
> `src/components/live/options/index.js`, and (3) the chart-type picker + its
> options form in the panel editor (`pages/live/` components). Skipping (1) yields
> the `"Chart type must be one of: …"` error.

---

## 6. Debugging checklist

- **Blank chart, no error** → most likely the viz type name mismatch or the panel's
  data source isn't returning series. Check `GENERIC_BUILDERS` in `options/index.js`
  for the viz-type key.
- **Chart never updates on new data** → the builder isn't memoized, or `seriesList`
  identity changed when it shouldn't. In `LivePanel.jsx`, verify `useMemo` deps.
- **Option key ignored** → check the ECharts Option docs for correct nesting level
  (e.g. `visualMap` is top-level, not nested under `series`).
- **Labels clipped** → increase `grid.left/right/bottom` in the builder, or thin
  ticks with `axisLabel.interval`.
- **Colours drift between editor and chart** → both must go through `colorAt(i)` /
  `SERIES_PALETTE`; don't hardcode hex codes.
- **Chart doesn't resize after sidebar collapse** → the `EChart` component owns a
  `ResizeObserver`; verify the container div's width/height are actually changing
  in the browser dev tools (React DevTools Profiler).
- Inspect the live option object: temporarily add `console.log(option)` in
  `LivePanel.jsx` where the option is built, or read `panel.options` straight
  from the DB row via psql.
