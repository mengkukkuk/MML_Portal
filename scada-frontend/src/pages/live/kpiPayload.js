/**
 * kpiPayload.js — pure logic for creating and saving Live management blocks
 * (Loss meter, Andon board, Loss waterfall): the palette catalogue, the
 * defaults a dropped block starts with, and the payloads sent to /api/panels.
 *
 * Mirrors scada-mml-backend/kpi_options.py (KPI_DEFAULTS, KPI_POLL_INTERVALS,
 * LOSSMETER_MODES) — the server validates, these only pre-fill. Keep both sides
 * in sync when adding a setting.
 */

/** Palette entries, management blocks first. `icon` resolves in BlockPalette.jsx. */
export const MANAGEMENT_BLOCKS = Object.freeze([
  { value: 'lossmeter', label: 'Loss meter', icon: 'lossmeter', hint: 'Cost of defects or production lost, in ฿' },
  { value: 'andon', label: 'Andon board', icon: 'andon', hint: 'Run / slow / stop per machine' },
  { value: 'waterfall', label: 'Loss waterfall', icon: 'waterfall', hint: 'Where the possible output went' },
  { value: 'kpistrip', label: 'KPI strip', icon: 'kpistrip', hint: 'Up to six headline numbers in a row' },
  { value: 'pace', label: 'Plan pace', icon: 'pace', hint: 'Good pieces against the plan, with stops' },
  { value: 'hourly', label: 'Hourly defect rate', icon: 'hourly', hint: 'Which hours were worse than average' },
  { value: 'sensors', label: 'Sensor strip', icon: 'sensors', hint: 'Out of band, frozen or missing, per sensor' },
  { value: 'response', label: 'Response board', icon: 'response', hint: 'Incidents, who answered, how fast' },
  { value: 'kpitrend', label: '7-day trend', icon: 'kpitrend', hint: 'Yield, running time and blind time by day' },
  { value: 'pareto', label: 'Defect Pareto', icon: 'pareto', hint: 'Defects by camera and type, largest first' },
])

/** What a KPI strip can show — mirrors KPI_METRICS in kpi_options.py. */
export const KPI_METRIC_KEYS = [
  'plan_pct', 'yield', 'availability', 'risk_pieces', 'blind_min', 'avg_response_min',
  'good', 'pieces', 'defects', 'defect_rate', 'lost', 'cost_total', 'incidents',
]
export const MAX_STRIP_METRICS = 6

export const KPI_CHART_TYPES = new Set(MANAGEMENT_BLOCKS.map((b) => b.value))

export function isKpiPanel(panel) {
  return panel?.source === 'kpi'
}

/** Every Live interval; see kpi_options.py on why a slow link wants 30 s or more. */
export const KPI_POLL_INTERVALS = [5, 10, 30, 60, 600, 1800, 3600]

export const KPI_DEFAULTS = Object.freeze({
  ts_col: null,
  location: null,
  // The Response board's incident location (a response role's location); null = every
  // location. The block's own choice: not in INHERITED_KPI_KEYS.
  response_location: null,
  // The Response board lists alerts from this level up; lower ones are only counted.
  alert_min_severity: 'warn',
  slots: { speed: 'count_1', defects: 'defect_*' },
  // Explicit column binding; null / absent leaves per-machine column detection in charge.
  // `output_col` + `machine_col` bind every machine block; `defect_cols` alone is the Loss meter's tally.
  machine_col: null,
  output_col: null,
  value_kind: 'rate',
  defect_cols: null,
  array_mode: 'sum',
  filter_col: null,
  filter_val: null,
  exclude_families: [],
  period: 'today',
  compare: true,
  mode: 'defects',
  cost_per_piece: null,
  targets: {},
  run_ratio: 0.8,
  stop_threshold: 0,
  min_stop_sec: 60,
  valid_max: 50000,
  max_loss_stop_min: 120,
  working_hours: null,
  sample_sec: 10,
  scope: 'line',
  line_family: null,
  plan_pieces: null,
  metrics: ['plan_pct', 'yield', 'availability', 'risk_pieces', 'blind_min', 'avg_response_min'],
  sensors: null,
  flat_min: 10,
})

/**
 * `kpi` as it goes to the server. The Loss meter's column picks are sent only
 * while they are in use, so a block that never picked a column posts exactly the
 * settings it always did (and a server that predates the picks still accepts it).
 */
export function cleanKpi(kpi) {
  const out = { ...kpi }
  if (out.output_col == null) { delete out.output_col; delete out.machine_col; delete out.value_kind }
  else {
    if (out.machine_col == null) delete out.machine_col
    if (out.value_kind === 'rate') delete out.value_kind
  }
  if (out.defect_cols == null) { delete out.defect_cols; delete out.array_mode }
  else if (out.array_mode === 'sum') delete out.array_mode
  if (out.filter_col == null) { delete out.filter_col; delete out.filter_val }
  if (out.response_location == null) delete out.response_location
  if (out.alert_min_severity == null || out.alert_min_severity === 'warn') delete out.alert_min_severity
  return out
}

/** The Loss meter counting picked defect columns, with no output column to judge machines by. */
export function isDefectTally(kpi) {
  return kpi?.defect_cols != null && kpi?.output_col == null
}

/** Smallest grid size (cols × rows) each block stays readable at. */
export const KPI_MIN_SIZE = Object.freeze({
  lossmeter: { w: 3, h: 5 },
  andon: { w: 4, h: 6 },
  waterfall: { w: 4, h: 9 },
  kpistrip: { w: 6, h: 4 },
  pace: { w: 5, h: 8 },
  hourly: { w: 4, h: 7 },
  sensors: { w: 5, h: 6 },
  response: { w: 5, h: 6 },
  kpitrend: { w: 6, h: 6 },
  pareto: { w: 4, h: 7 },
})

/** The size a block lands at when dropped or clicked in. */
export const KPI_DROP_SIZE = Object.freeze({
  lossmeter: { w: 4, h: 6 },
  andon: { w: 8, h: 9 },
  waterfall: { w: 6, h: 11 },
  kpistrip: { w: 12, h: 5 },
  pace: { w: 12, h: 10 },
  hourly: { w: 6, h: 8 },
  sensors: { w: 7, h: 8 },
  response: { w: 7, h: 8 },
  kpitrend: { w: 12, h: 7 },
  pareto: { w: 5, h: 8 },
})

const DEFAULT_TITLES = {
  lossmeter: 'Defect cost',
  andon: 'Machine status',
  waterfall: 'Where output went',
  kpistrip: 'Shift at a glance',
  pace: 'Making the plan?',
  hourly: 'Defect rate by hour',
  sensors: 'Sensor status',
  response: 'Alerts and who must act',
  kpitrend: '7-day trend',
  pareto: 'Where defects come from',
}

/** Settings a new block copies from the board's newest block, so blocks that
 * read the same line apply the same loss rules — a target typed on the Andon
 * board must not leave the waterfall judging "slow" against the auto target. */
const INHERITED_KPI_KEYS = [
  'ts_col', 'location', 'slots', 'machine_col', 'output_col', 'value_kind', 'defect_cols', 'array_mode', 'filter_col', 'filter_val', 'exclude_families', 'period', 'compare', 'cost_per_piece',
  'targets', 'run_ratio', 'stop_threshold', 'min_stop_sec', 'valid_max', 'max_loss_stop_min',
  'working_hours', 'sample_sec', 'scope', 'line_family', 'plan_pieces', 'sensors', 'flat_min',
]

/**
 * Where a newly dropped block should read from, and by which rules: the most
 * recently created management block on this dashboard if there is one (a
 * board is usually about one line), else the operator's primary datasource
 * with no table yet. The Loss meter's `mode` is the block's own and is not
 * inherited.
 *
 * Only the Loss meter can read a table by counting picked defect columns. Any
 * other block judges machines — by per-machine columns or an output column — so
 * for those `type` skips a block that only tallies defects: copying its table
 * would make the server refuse the new block. It falls back to the newest
 * machine-bound one, or to unbound.
 */
export function inheritBinding(panels, primaryDatasourceId = null, type = null) {
  const needsMachines = type != null && type !== 'lossmeter'
  const last = [...(panels || [])]
    .filter((p) => isKpiPanel(p) && p.table_name)
    .filter((p) => !(needsMachines && isDefectTally(p.options?.kpi)))
    .sort((a, b) => b.id - a.id)[0]
  if (!last) return { datasource_id: primaryDatasourceId ?? null, table_name: null, kpi: {} }
  const k = last.options?.kpi || {}
  const kpi = {}
  for (const key of INHERITED_KPI_KEYS) {
    if (k[key] !== undefined) kpi[key] = JSON.parse(JSON.stringify(k[key]))
  }
  return { datasource_id: last.datasource_id ?? null, table_name: last.table_name, kpi }
}

/** A complete create payload for a block of `type` dropped at `layout`. */
export function defaultKpiPanel(type, { binding, layout, dashboardId, position, page = 0 }) {
  const kpi = cleanKpi({
    ...KPI_DEFAULTS,
    ...(binding?.kpi || {}),
    ...(type === 'lossmeter' ? { mode: 'defects' } : {}),
  })
  return {
    title: DEFAULT_TITLES[type] || 'Management block',
    source: 'kpi',
    chart_type: type,
    device_id: null,
    tag_name: null,
    datasource_id: binding?.datasource_id ?? null,
    table_name: binding?.table_name ?? null,
    metric: null,
    filter_col: null,
    ts_col: kpi.ts_col,
    window_minutes: 15,
    poll_interval_seconds: 60,
    dashboard_id: dashboardId,
    position: position ?? 0,
    // `page`: the dashboard page in view (boardPages.js); the first page is left implicit
    options: { kpi, layout, ...(page ? { page } : {}) },
  }
}

/** The PUT payload for an edited block — the inspector's draft over the saved panel. */
export function buildKpiSavePayload(panel, draft) {
  return {
    title: (draft.title ?? panel.title).trim() || panel.title,
    source: 'kpi',
    chart_type: panel.chart_type,
    device_id: null,
    tag_name: null,
    datasource_id: draft.datasource_id ?? null,
    table_name: draft.table_name || null,
    metric: null,
    filter_col: null,
    ts_col: draft.kpi?.ts_col ?? null,
    window_minutes: panel.window_minutes ?? 15,
    poll_interval_seconds: panel.poll_interval_seconds ?? 60,
    dashboard_id: panel.dashboard_id,
    position: panel.position ?? 0,
    options: { ...(panel.options || {}), kpi: cleanKpi(draft.kpi) },
  }
}

/** A draft the inspector edits, from a saved panel. */
export function draftFromPanel(panel) {
  return {
    title: panel.title,
    datasource_id: panel.datasource_id ?? null,
    table_name: panel.table_name ?? null,
    kpi: { ...KPI_DEFAULTS, ...(panel.options?.kpi || {}) },
  }
}

/** The draft as a panel the tile can render while it is being edited. */
export function panelWithDraft(panel, draft) {
  if (!draft) return panel
  return {
    ...panel,
    title: draft.title,
    datasource_id: draft.datasource_id,
    table_name: draft.table_name,
    options: { ...(panel.options || {}), kpi: draft.kpi },
  }
}

/** Parse "07:00" etc.; '' or invalid → null. */
export function workingHoursFrom(start, end, days) {
  const ok = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '')
  if (!ok(start) || !ok(end) || start === end || !days?.length) return null
  return { start, end, days: [...new Set(days)].sort() }
}

/** Blocks whose incidents can be narrowed to one location (kpi.py's WANTS["response"]). */
export const RESPONSE_LOCATION_TYPES = Object.freeze(['response', 'kpistrip'])

const squashPlace = (text) => String(text ?? '').replace(/\s+/g, '').toLowerCase()

/**
 * The places a Response board can be narrowed to: the response roles'
 * locations, then `seen` — the locations the alerts themselves carry, so a
 * place spelled unlike its rule ("L13" against "Line 13") can still be picked.
 * Each spelling once (case and spaces ignored, as the server matches), without
 * blank or `global` — those mean every location, which is the picker's own
 * "All locations".
 */
export function responseLocations(roles, seen = []) {
  const found = new Map()
  for (const place of [...(roles || []).map((r) => r?.location), ...(seen || [])]) {
    const key = squashPlace(String(place ?? '').trim())
    if (!key || key === 'global' || found.has(key)) continue
    found.set(key, String(place).trim())
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b))
}
