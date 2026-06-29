# Dashboard Dev Guide — ECharts Parameter Tuning (Expert Level)

How the Live dashboard renders charts, and exactly which knobs to turn to change
their behaviour. This is the deep-dive reference for `LivePanel.vue` —
the Grafana-style single-tile renderer at
`scada-frontend/src/components/LivePanel.vue`. `TrendChart.vue` is the simpler
multi-series line chart on Overview/Trends and follows the same idioms.

> **Library:** [Apache ECharts 5](https://echarts.apache.org/en/option.html) via
> [`vue-echarts`](https://github.com/ecomfe/vue-echarts). The canonical reference
> for every option key below is the ECharts **Option** docs — when in doubt,
> search the option name there.

---

## 1. The render pipeline in 30 seconds

```
panel (DB row)  ──▶  seriesSpecs  ──▶  fetch/poll  ──▶  seriesPoints / seriesLatest
       │                                                        │
       │                                                        ▼
   chart_type ───────────────────────▶  option = computed()  ──▶  <VChart :option>
   options (JSONB)                       (one *Option() builder per viz type)
```

Key facts that govern everything else:

- **`panel.chart_type`** selects which `*Option()` builder runs (see the `switch`
  in `option = computed()`, `LivePanel.vue:567`). `'line'` is normalised to
  `'timeseries'` by `vizType` (`:79`).
- **`panel.options`** (a JSONB blob, exposed as `opts`) carries every tuning
  parameter. **This is the object you edit to adjust a chart.** All keys are
  optional with sane fallbacks.
- The `option` object is a **`computed`** — reassigning `seriesPoints.value` /
  `seriesLatest.value` (always immutably, e.g. `{ ...prev }`) is what makes
  ECharts recompute and repaint. Never mutate arrays/objects in place or the
  chart will not update.
- `<VChart autoresize>` handles container resizes; you never call
  `chart.resize()` manually.

### Tree-shaken imports — the #1 gotcha

ECharts is imported piecemeal (`LivePanel.vue:14-25`). **If you use a chart type,
component, or feature whose module is not in the `use([...])` call, it silently
does nothing** (no error, just a blank/broken chart). Currently registered:

```js
use([
  CanvasRenderer,
  LineChart, BarChart, GaugeChart, PieChart, ScatterChart,
  HeatmapChart, CandlestickChart, CustomChart,
  GridComponent, TooltipComponent, LegendComponent, VisualMapComponent,
])
```

If you add e.g. `markLine`, `dataZoom`, `toolbox`, or `graphic`, you **must** add
the matching component (`MarkLineComponent`, `DataZoomComponent`,
`ToolboxComponent`, `GraphicComponent`) to the `use([...])` list and the import
above it. Same for a new chart family.

---

## 2. The `panel.options` knob reference

Every field below lives under `panel.options`. They are read through the `opts`
computed and feed the `*Option()` builders. Grouped by what they affect.

### Universal

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `decimals` | int | `null` (raw) | Digits after the decimal in every formatted value. Drives `fmt()` (`:144`), tooltips, labels, table cells. |
| `mathExpr` | string | `''` | Safe per-reading transform applied **at ingest** (`:142`, `applyExpr`). All renderers + thresholds see post-transform numbers. Grammar: `value`, `+ - * / ^`, `abs sqrt pow min max floor ceil round`. e.g. `value/10`, `pow(value,2)`. No `eval`/`Function`. |
| `warn` / `crit` | number | `null` | "value ≥" thresholds. Colour escalation via `thColor()` (`:151`): base → amber `#e6a23c` → red `#f56c6c`. Used by stat, bargauge, gauge. |

### Time series (`timeseries` / legacy `line`) — `timeseriesOption()` `:170`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `smooth` | bool | `true` | Spline smoothing. Set `false` for sharp step-free polylines. (`smooth: opts.smooth !== false`.) |
| `lineWidth` | int | `2` | `lineStyle.width` in px. |
| `area` | bool | `true` | Gradient area fill under the line. Auto-disabled when multi-series (muddy when stacked). Set `false` to force off. |

### Bar — `barOption()` `:194`
Inherits the universal knobs; bars use `colorAt(i)` and a 2px top border radius.
No bar-specific options yet (add `barWidth`/`barGap` here if needed).

### Bar gauge — `barGaugeOption()` `:212`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `min` / `max` | number | `0` / `100` | Value-axis bounds. |
| `orientation` | `'vertical'`\|other | horizontal | `'vertical'` swaps category/value axes (bars grow up instead of right). |

### Histogram — `histogramOption()` `:237`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `buckets` | int ≥ 2 | `20` | Number of equal-width bins across the shared `[min,max]` of all series. X-axis label interval auto-thins to ~8 ticks. |

### Pie / Donut — `pieOption()` `:270`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `donut` | bool | `true` | Donut hole on/off. `false` ⇒ solid pie (`inner = '0'`). |
| `innerRadius` | int (%) | `50` | Donut hole radius as a percentage. Outer radius is fixed `'72%'`. |
| `labelPosition` | `'outside'`\|`'inside'`\|`'center'`\|`'none'` | `'outside'` | Slice label placement; `'none'` hides labels. |

### Heatmap — `heatmapOption()` `:302`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `bucketMinutes` | int | `5` | Time-bucket width (min 60s enforced). Cell colour = **average** value in bucket. |
| `colorMin` / `colorMax` | number | data range | Pins the `visualMap` domain so colours stay stable across refreshes. The colour ramp is green→amber→red (`inRange.color`, `:369`). |

### Scatter — `scatterOption()` `:376`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `pointSize` | int | `6` | `symbolSize` per point; marker opacity fixed at 0.75. |

### State timeline — `stateTimelineOption()` `:399`
Custom-rendered Gantt bands (`type: 'custom'` + `renderItem`).

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `roundValues` | bool | `true` | Round values to int when deriving discrete states. `false` uses `fmt()` precision instead — more distinct states. |

Band height is the `BAND_H = 22` constant (`:436`); change it there, and the tile
auto-heights via `chartStyle` (`:581`).

### Candlestick — `candlestickOption()` `:485`

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `bucketMinutes` | int | `5` | OHLC aggregation window (min 60s). Open=first, Close=last, Low/High=min/max in bucket. |

### Gauge (radial) — `gaugeOptionFor()` `:529`
Rendered as **small multiples** — one radial gauge per series.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `min` / `max` | number | `0` / `100` | Gauge sweep range. |
| `warn` / `crit` | number | `null` | Build the coloured `axisLine` stops (base → warn → crit zones). |

### Stat & Table (non-ECharts DOM, for completeness)

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `sparkline` | bool | `true` | Stat tiles show a mini line chart (`sparklineOptionFor()` `:557`); single-series only. |
| `maxRows` | int | `10` | Table source: max recent rows rendered. |
| `value_cols` / `filters` / `tags` | array | — | Data-binding multipliers (see §5), not visual knobs. |

---

## 3. Shared style fragments — change the look in one place

These helpers (`LivePanel.vue:158-167`) are reused across most builders. Edit them
once to restyle every chart consistently:

- **`legendCfg()`** — scrollable legend, only shown when multi-series. Tune
  `fontSize`, `itemWidth/Height`, `top` here.
- **`gridTop()`** — top padding (30 when legend present, else 12). The rest of the
  grid (`right/bottom/left`) is set per builder; bump `left` if Y-axis labels clip.
- **`timeAxis()` / `valueAxis()`** — the dark-theme time/value axes. Axis colours
  (`#8a99b3` labels, `rgba(255,255,255,0.06)` split lines) live here.
- **`tooltipAxis()`** — axis-trigger tooltip with the `valueFormatter` that appends
  `unit`. Per-series/item tooltips (pie, scatter, heatmap, candlestick, state) use
  a bespoke `formatter` inline because they need custom layout.

The dark palette constants: panel bg `#172238`, fg `#e6edf7`, muted `#8a99b3`,
warn `#e6a23c`, crit `#f56c6c`. Series colours come from `SERIES_PALETTE`
(`src/utils/seriesPalette.js`) via `colorAt(i)` (wraps after 10 series). The
editor previews use the **same** palette so swatches match the chart.

---

## 4. Recipes — common "leet" tweaks

### Add a brush/zoom (dataZoom) to time-series
1. `import { DataZoomComponent } from 'echarts/components'` and add it to `use([...])`.
2. In `timeseriesOption()`, add:
   ```js
   dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }],
   ```
3. Bump `grid.bottom` to make room for the slider.

### Pin the Y-axis to a fixed range
`valueAxis()` uses `scale: true` (auto). For a fixed range on a specific builder,
override after spreading: `yAxis: { ...valueAxis(), min: 0, max: 100, scale: false }`.

### Stack multiple bar/line series
Add `stack: 'total'` to each series object in `barOption()`/`timeseriesOption()`.
Note: area fills are intentionally dropped for multi-series lines (`:188`) — re-enable
with care, stacked translucent areas read as mud.

### Add threshold guide lines (markLine)
1. Register `MarkLineComponent`, add to `use([...])`.
2. Per series (or one series):
   ```js
   markLine: { silent: true, symbol: 'none', data: [
     opts.value.warn != null && { yAxis: opts.value.warn, lineStyle: { color: WARN_COLOR } },
     opts.value.crit != null && { yAxis: opts.value.crit, lineStyle: { color: CRIT_COLOR } },
   ].filter(Boolean) }
   ```

### Performance for high-frequency series
- Time-series with thousands of points: add `large: true` + `largeThreshold: 2000`
  to the line series, and keep `showSymbol: false` (already the case past 1 point).
- Polling already trims to the panel window via `trimWindow()` (`:613`) using
  `panel.window_minutes`, so the point count is bounded by window ÷ poll interval.
- Prefer `sampling: 'lttb'` on the line series for downsampled rendering of dense data.

### Custom renderItem (like state timeline)
The state timeline (`:462`) is the reference for `type: 'custom'`: read encoded
values via `api.value(i)`, map to pixels with `api.coord([...])`, return a shape
(`rect` here). Mirror this for waterfall/range/annotation visuals. Requires
`CustomChart` (already registered).

---

## 5. Data binding (so visuals have something to draw)

Series are derived in **`seriesSpecs`** (`:87`). One entry per output series:

- **`source: 'tag'`** — `options.tags[]` (or single `tag_name`) → one series each,
  `metric` is the numeric column from `public.variables_tag`. No native history → starts
  empty, accumulates per poll, sampled at wall-clock so steady values still advance.
- **`source: 'table'`** — cartesian of `options.value_cols[]` × `options.filters[]`
  (with `filter_col`). With a `ts_col` it seeds real history; without one it behaves
  like the tag source.
- **`source: 'device'`** — single series from `device_id` + `metric` on
  `public.sensor_readings`.

`seriesList` (`:123`) hydrates each spec with its `color` + `points` + `latest` for
the renderers. `isMulti` (≥2 series) drives legend visibility, label chips, area-fill
suppression, and gauge/heatmap sizing. Each point is `[epochMs, value]`.

> Backend note: valid `chart_type` values are validated in
> `scada-mml-backend/panels.py`. **A new viz type needs three coordinated edits:**
> (1) the backend allow-list, (2) a `*Option()` builder + `switch` case here, and
> (3) the chart-type picker + its options form in `LivePage.vue`. Skipping (1) yields
> the `"Chart type must be one of: …"` error.

---

## 6. Debugging checklist

- **Blank chart, no error** → chart type / component not in `use([...])`.
- **Chart never updates on new data** → you mutated `seriesPoints`/`seriesLatest`
  in place instead of reassigning a new object.
- **Option key ignored** → its component isn't registered (e.g. `visualMap` needs
  `VisualMapComponent`), or you put it on the wrong nesting level — cross-check the
  ECharts Option docs.
- **Labels clipped** → increase `grid.left/right/bottom` in the builder, or thin
  ticks with `axisLabel.interval`.
- **Colours drift between editor and chart** → both must go through `colorAt(i)` /
  `SERIES_PALETTE`; don't hardcode.
- Inspect the live option object: temporarily `watch(option, o => console.log(o))`
  in the component, or read `panel.options` straight from the DB row.
