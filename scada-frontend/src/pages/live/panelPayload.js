import { compileExpr } from '@/utils/mathExpr'

/**
 * panelPayload.js — pure, framework-agnostic logic ported verbatim from
 * LivePage.vue's <script setup>: the panel-editor's visualization catalogue
 * + per-type parameter schema (PARAM_SCHEMA, ~lines 68-129), the legacy
 * device/tag -> generic-table binding shim, the react-grid-layout geometry
 * helpers (nextLayoutSlot/layoutFromPanels/panelMinSize/seriesCount,
 * ~lines 727-815), and the save-payload builders reused by both
 * PanelEditorDialog's Save button (LivePage.vue:478+) and LivePage.jsx's
 * saveLayout() (LivePage.vue:830+).
 *
 * No React/JSX here by design (icons for VIZ_TYPE_META live in
 * PanelEditorDialog.jsx, which maps `icon` below to an actual
 * @mui/icons-material component) — keeps this module trivially testable and
 * reusable from both PanelEditorDialog and LivePage.
 */

// Legacy tag API field names -> real variables_tag column names, so editing an
// old tag panel maps cleanly onto the generic table model.
export const TAG_FIELD_TO_COL = { current_value: 'current_value_tag' }

// Poll-interval choices shown in the editor dialog (full labels). LivePanel's
// gear popover uses its own compact-label copy (usePanelSeries.js's
// POLL_INTERVALS) — kept separate on purpose since the two UIs want
// different label lengths for the same whitelist of seconds.
export const POLL_INTERVAL_OPTIONS = [
  { value: 5, label: '5 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
]

// Alert-condition row connectors.
export const CONNECTORS = ['AND', 'OR']

// Visualization catalogue (mirrors LivePanel's renderers). `icon` is a string
// key resolved to an @mui/icons-material component by PanelEditorDialog.jsx
// (per-path imports only — see router/routes.jsx's precedent).
export const VIZ_TYPE_META = [
  { value: 'timeseries', label: 'Time series', icon: 'timeseries', hint: 'Time based line & area charts' },
  { value: 'bar', label: 'Bar chart', icon: 'bar', hint: 'Value bars over time' },
  { value: 'stat', label: 'Stat', icon: 'stat', hint: 'Big value & sparkline' },
  { value: 'gauge', label: 'Gauge', icon: 'gauge', hint: 'Radial gauge with thresholds' },
  { value: 'bargauge', label: 'Bar gauge', icon: 'bargauge', hint: 'Horizontal / vertical level bar' },
  { value: 'histogram', label: 'Histogram', icon: 'histogram', hint: 'Distribution of values' },
  { value: 'table', label: 'Table', icon: 'table', hint: 'Recent readings table' },
  { value: 'pie', label: 'Pie / Donut', icon: 'pie', hint: 'Proportional breakdown of series values' },
  { value: 'heatmap', label: 'Heatmap', icon: 'heatmap', hint: 'Value intensity across time × series' },
  { value: 'scatter', label: 'Scatter', icon: 'scatter', hint: 'Individual data points over time' },
  { value: 'statetimeline', label: 'State timeline', icon: 'statetimeline', hint: 'Discrete state bands over time (ON/OFF, OPEN/CLOSED)' },
  { value: 'candlestick', label: 'Candlestick', icon: 'candlestick', hint: 'Min / open / close / max per interval' },
]

// Per-type parameter schema rendered by ParamFields.jsx.
// field types: 'switch' | 'number' | 'enum'
export const PARAM_SCHEMA = {
  timeseries: [
    { key: 'smooth', label: 'Smooth line', type: 'switch', default: true },
    { key: 'area', label: 'Fill area', type: 'switch', default: true },
    { key: 'lineWidth', label: 'Line width', type: 'number', default: 2, min: 1, max: 6 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  bar: [
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  stat: [
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
    { key: 'sparkline', label: 'Show sparkline', type: 'switch', default: true },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  gauge: [
    { key: 'min', label: 'Min', type: 'number', default: 0 },
    { key: 'max', label: 'Max', type: 'number', default: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  bargauge: [
    { key: 'min', label: 'Min', type: 'number', default: 0 },
    { key: 'max', label: 'Max', type: 'number', default: 100 },
    { key: 'orientation', label: 'Orientation', type: 'enum', options: ['horizontal', 'vertical'], default: 'horizontal' },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  histogram: [
    { key: 'buckets', label: 'Buckets', type: 'number', default: 20, min: 2, max: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  table: [
    { key: 'maxRows', label: 'Max rows', type: 'number', default: 10, min: 1, max: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  pie: [
    { key: 'donut', label: 'Donut style', type: 'switch', default: true },
    { key: 'innerRadius', label: 'Inner radius %', type: 'number', default: 50, min: 10, max: 80 },
    { key: 'labelPosition', label: 'Labels', type: 'enum', options: ['outside', 'inside', 'none'], default: 'outside' },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  heatmap: [
    { key: 'bucketMinutes', label: 'Bucket (min)', type: 'number', default: 5, min: 1, max: 60 },
    { key: 'colorMin', label: 'Color min', type: 'number', default: null, nullable: true },
    { key: 'colorMax', label: 'Color max', type: 'number', default: null, nullable: true },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  scatter: [
    { key: 'pointSize', label: 'Point size', type: 'number', default: 6, min: 2, max: 20 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  statetimeline: [
    { key: 'roundValues', label: 'Round to integer', type: 'switch', default: true },
  ],
  candlestick: [
    { key: 'bucketMinutes', label: 'Bucket (min)', type: 'number', default: 5, min: 1, max: 60 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
}

export function defaultOptions(type) {
  const out = {}
  for (const f of PARAM_SCHEMA[type] || []) out[f.key] = f.default
  return out
}

/**
 * MUI TextField type="number" yields '' when blank, and Number('') === 0 —
 * silently turning a cleared warn/crit/min/max/gauge-bound field into a real
 * 0 threshold. Every nullable numeric field in the editor must round-trip
 * through this before it rides into panel.options.
 */
export function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Best-effort map of a legacy tag/device panel onto the generic table model,
// so opening an old panel in the editor pre-fills sensible table/metric/
// filter values instead of a blank form.
export function legacyBinding(panel) {
  if (panel.source === 'tag') {
    return {
      table: 'variables_tag',
      metric: TAG_FIELD_TO_COL[panel.metric] || panel.metric,
      filter_col: 'tag_name',
      filters: panel.options?.tags?.length ? [...panel.options.tags] : (panel.tag_name ? [panel.tag_name] : []),
      // variables_tag updates one row in place; leave ts unset so the tile
      // samples at the poll clock (its prior behaviour) instead of degenerate history.
      ts_col: null,
    }
  }
  if (panel.source === 'device') {
    return {
      table: 'sensor_readings', metric: 'value', filter_col: 'metric',
      filters: panel.metric ? [panel.metric] : [], ts_col: 'ts',
    }
  }
  return null
}

// --- react-grid-layout geometry -------------------------------------------

// Count the series a panel will render. Mirrors usePanelSeries' seriesSpecs
// logic so the grid can size the tile to fit them all.
export function seriesCount(panel) {
  if (!panel) return 1
  if (panel.source === 'tag') {
    const tags = panel.options?.tags
    if (Array.isArray(tags) && tags.length) return tags.length
    return panel.tag_name ? 1 : 0
  }
  if (panel.source === 'table') {
    const extras = panel.options?.value_cols
    const valueCols = 1 + (Array.isArray(extras) ? extras.filter(Boolean).length : 0)
    const filters = panel.options?.filters
    const hasFilter = !!panel.filter_col && Array.isArray(filters) && filters.length > 0
    return valueCols * (hasFilter ? filters.length : 1)
  }
  return 1
}

// Per-chart-type minimum grid size (cols x rows) that still shows ALL
// selected series AND keeps the ECharts canvas visible. See
// LivePage.vue:746-790 for the full per-type layout-budget rationale.
export function panelMinSize(panel) {
  const n = Math.max(1, seriesCount(panel))
  const clampW = (w) => Math.max(2, Math.min(12, w))
  const clampH = (h) => Math.max(3, Math.min(30, h))
  switch (panel?.chart_type) {
    case 'stat':
      if (n === 1) return { w: clampW(2), h: clampH(5) }
      return { w: clampW(2), h: clampH(4 + 2 * n) }
    case 'gauge':
      return { w: clampW(3 + (n - 1) * 2), h: clampH(8) }
    case 'bargauge':
      return panel.options?.orientation === 'vertical'
        ? { w: clampW(2 + n), h: clampH(7) }
        : { w: clampW(3), h: clampH(4 + n) }
    case 'table':
      return { w: clampW(2 + n), h: clampH(5) }
    case 'statetimeline':
      return { w: clampW(4), h: clampH(4 + 2 * n) }
    case 'heatmap':
      return { w: clampW(4), h: clampH(5 + n) }
    case 'pie':
      return { w: clampW(4), h: clampH(8) }
    default:
      return { w: clampW(3), h: clampH(8) }
  }
}

// Next free slot at the bottom of the grid for a freshly created/duplicated panel.
export function nextLayoutSlot(layout) {
  const maxY = (layout || []).reduce((m, it) => Math.max(m, it.y + it.h), 0)
  return { x: 0, y: maxY, w: 6, h: 9 }
}

// Build the react-grid-layout item array from panels. Uses each panel's
// persisted options.layout when present; otherwise synthesizes a two-up
// 12-col layout from the array index (vertical-compact then tidies gaps).
//
// Saved w/h are floored at the panel's own panelMinSize. A stored size below
// that floor is invalid by definition — the editor never produces one, and RGL
// enforces it as minW/minH during resize — so it can only come from a layout
// captured while the grid was collapsed to a narrower column count, which
// clamps every w down. Repairing on read keeps one bad save from permanently
// rendering a tile too small to show its own chart.
export function layoutFromPanels(panels) {
  return (panels || []).map((p, idx) => {
    const min = panelMinSize(p)
    const saved = p.options?.layout
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return {
        i: String(p.id),
        x: saved.x,
        y: saved.y,
        w: Math.max(min.w, saved.w || 6),
        h: Math.max(min.h, saved.h || 9),
      }
    }
    return { i: String(p.id), x: (idx % 2) * 6, y: Math.floor(idx / 2) * 9, w: 6, h: 9 }
  })
}

// Append a layout item for a panel that was just created/duplicated, without
// disturbing any other (possibly still-unsaved, mid-edit-mode-drag) entries.
export function appendLayoutItem(layout, panel) {
  const lay = panel.options?.layout || nextLayoutSlot(layout)
  return [...(layout || []), { i: String(panel.id), x: lay.x, y: lay.y, w: lay.w, h: lay.h }]
}

// --- save-payload builders --------------------------------------------------

/**
 * Validate + assemble the full panel payload the editor's Save button sends
 * to createPanel/updatePanel. Mirrors LivePage.vue's save() (lines 478-567)
 * verbatim, including its validation order and error messages.
 *
 * `form` is the react-hook-form values object; `editingPanel` is the panel
 * being edited (null when creating); `nextLayout` is the {x,y,w,h} slot to
 * use for a brand-new panel (ignored when editing — the panel's existing
 * layout is preserved as-is).
 */
export function buildPanelPayload({
  form, editingPanel, activeDashboardId, panelsLength, nextLayout,
}) {
  if (!form.title?.trim()) return { ok: false, error: 'Title is required.' }
  if (!form.table_name || !form.metric) return { ok: false, error: 'Pick a table and a value column.' }
  if (form.filter_col && !(form.filters || []).length) {
    return { ok: false, error: 'Add at least one series value, or clear the filter column.' }
  }

  const compiled = compileExpr(form.mathExpr)
  if (!compiled.ok) return { ok: false, error: `Expression: ${compiled.error}` }

  // Prune incomplete conditions: a row needs lhs, op and a non-empty rhs; a
  // condition needs at least one surviving row. The first surviving row
  // carries no connector.
  const allValueCols = [form.metric, ...(form.value_cols || [])].filter(Boolean)
  const known = new Set(allValueCols)
  const cleanConditions = []
  for (const c of form.conditions || []) {
    const rows = []
    for (const r of c.rows || []) {
      if (!r.lhs || !r.op || r.rhs === '' || r.rhs == null) continue
      if (r.rhsType === 'series' && !known.has(r.rhs)) {
        return { ok: false, error: `Condition references unknown series "${r.rhs}".` }
      }
      const row = { lhs: r.lhs, op: r.op, rhsType: r.rhsType, rhs: r.rhsType === 'series' ? r.rhs : Number(r.rhs) }
      if (rows.length) row.connector = r.connector === 'OR' ? 'OR' : 'AND'
      rows.push(row)
    }
    if (rows.length) cleanConditions.push({ rows })
  }

  const trimmedExpr = form.mathExpr?.trim() || ''
  const extraOpts = trimmedExpr ? { mathExpr: trimmedExpr } : {}
  const condOpts = cleanConditions.length ? { conditions: cleanConditions } : {}

  // Per-series display units: keyed by filter value when filtered, else by
  // value column. Pruned to the active keys so stale cross-mode keys don't ride.
  const unitKeys = form.filter_col ? (form.filters || []) : allValueCols
  const unitMap = {}
  for (const k of unitKeys) if (form.units?.[k]) unitMap[k] = form.units[k]

  // Per-series gauge overrides — same key precedence as units, pruned the
  // same way so a stale series' min/max/warn/crit never rides into save().
  const gaugeMap = {}
  if (form.chart_type === 'gauge') {
    for (const k of unitKeys) if (form.gaugeSeries?.[k]) gaugeMap[k] = { ...form.gaugeSeries[k] }
  }

  // Preserve the panel's layout when editing; seed a bottom slot when creating.
  const layoutOpt = editingPanel
    ? (editingPanel.options?.layout ? { layout: editingPanel.options.layout } : {})
    : { layout: nextLayout }

  const payload = {
    title: form.title.trim(),
    source: 'table',
    device_id: null,
    tag_name: null,
    datasource_id: form.datasource_id || null,
    table_name: form.table_name,
    metric: form.metric,
    filter_col: form.filter_col || null,
    ts_col: form.ts_col || null,
    window_minutes: form.window_minutes,
    chart_type: form.chart_type,
    options: {
      ...form.options,
      filters: [...(form.filters || [])],
      ...((form.value_cols || []).length ? { value_cols: [...form.value_cols] } : {}),
      ...(Object.keys(unitMap).length ? { units: unitMap } : {}),
      ...(Object.keys(gaugeMap).length ? { gaugeSeries: gaugeMap } : {}),
      ...extraOpts,
      ...condOpts,
      ...layoutOpt,
    },
    poll_interval_seconds: form.poll_interval_seconds,
    dashboard_id: activeDashboardId,
    position: editingPanel ? (editingPanel.position ?? 0) : panelsLength,
  }
  return { ok: true, payload }
}

/**
 * Full-payload shape for a layout-only save (LivePage.jsx's saveLayout,
 * mirroring LivePage.vue:845-861). Reuses every field off the existing panel
 * record so the backend round-trips everything unchanged except
 * options.layout — no schema change, no editor round-trip needed.
 */
export function buildLayoutSavePayload(panel, layout, activeDashboardId) {
  return {
    title: panel.title,
    source: panel.source || 'device',
    device_id: panel.device_id,
    tag_name: panel.tag_name,
    datasource_id: panel.datasource_id ?? null,
    table_name: panel.table_name,
    filter_col: panel.filter_col,
    ts_col: panel.ts_col,
    metric: panel.metric,
    window_minutes: panel.window_minutes,
    chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
    options: { ...(panel.options || {}), layout },
    poll_interval_seconds: panel.poll_interval_seconds,
    dashboard_id: panel.dashboard_id ?? activeDashboardId,
    position: panel.position,
  }
}

/** Duplicate-panel payload (mirrors LivePage.vue's confirmDuplicate, lines 655-671). */
export function buildDuplicatePayload(panel, title, { activeDashboardId, panelsLength, nextLayout }) {
  const clonedOptions = JSON.parse(JSON.stringify(panel.options || {}))
  clonedOptions.layout = nextLayout
  return {
    title,
    source: panel.source || 'device',
    device_id: panel.device_id,
    tag_name: panel.tag_name,
    datasource_id: panel.datasource_id ?? null,
    table_name: panel.table_name,
    filter_col: panel.filter_col,
    ts_col: panel.ts_col,
    metric: panel.metric,
    window_minutes: panel.window_minutes,
    chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
    options: clonedOptions,
    poll_interval_seconds: panel.poll_interval_seconds || 5,
    dashboard_id: activeDashboardId,
    position: panelsLength,
  }
}
