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
])

export const KPI_CHART_TYPES = new Set(MANAGEMENT_BLOCKS.map((b) => b.value))

export function isKpiPanel(panel) {
  return panel?.source === 'kpi'
}

/** No 5 s: a ฿ figure jittering every five seconds tells the board nothing. */
export const KPI_POLL_INTERVALS = [30, 60, 600, 1800, 3600]

export const KPI_DEFAULTS = Object.freeze({
  ts_col: null,
  location: null,
  slots: { speed: 'count_1', defects: 'defect_*' },
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
})

/** Smallest grid size (cols × rows) each block stays readable at. */
export const KPI_MIN_SIZE = Object.freeze({
  lossmeter: { w: 3, h: 5 },
  andon: { w: 4, h: 6 },
  waterfall: { w: 4, h: 9 },
})

/** The size a block lands at when dropped or clicked in. */
export const KPI_DROP_SIZE = Object.freeze({
  lossmeter: { w: 4, h: 6 },
  andon: { w: 8, h: 9 },
  waterfall: { w: 6, h: 11 },
})

const DEFAULT_TITLES = {
  lossmeter: 'Defect cost',
  andon: 'Machine status',
  waterfall: 'Where output went',
}

/** Settings a new block copies from the board's newest block, so blocks that
 * read the same line apply the same loss rules — a target typed on the Andon
 * board must not leave the waterfall judging "slow" against the auto target. */
const INHERITED_KPI_KEYS = [
  'ts_col', 'location', 'slots', 'exclude_families', 'period', 'compare', 'cost_per_piece',
  'targets', 'run_ratio', 'stop_threshold', 'min_stop_sec', 'valid_max', 'max_loss_stop_min',
  'working_hours', 'sample_sec',
]

/**
 * Where a newly dropped block should read from, and by which rules: the most
 * recently created management block on this dashboard if there is one (a
 * board is usually about one line), else the operator's primary datasource
 * with no table yet. The Loss meter's `mode` is the block's own and is not
 * inherited.
 */
export function inheritBinding(panels, primaryDatasourceId = null) {
  const last = [...(panels || [])]
    .filter((p) => isKpiPanel(p) && p.table_name)
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
export function defaultKpiPanel(type, { binding, layout, dashboardId, position }) {
  const kpi = {
    ...KPI_DEFAULTS,
    ...(binding?.kpi || {}),
    ...(type === 'lossmeter' ? { mode: 'defects' } : {}),
  }
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
    options: { kpi, layout },
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
    options: { ...(panel.options || {}), kpi: { ...draft.kpi } },
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
