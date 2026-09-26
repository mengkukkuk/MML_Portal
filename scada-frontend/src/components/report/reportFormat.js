/**
 * Shared formatting and palette for the vision/camera-QC report blocks.
 *
 * Colours are literal hex rather than `var(--ok)` where they feed ECharts,
 * which paints to a canvas and cannot resolve CSS custom properties. Kept in
 * step with tokens.css by hand — if a token moves, move it here too.
 */

export const SEVERITY_COLORS = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3aa0ff',
}

/**
 * A camera's reporting state for the window — independent of its defect rate.
 * `no_data` means the pipeline never wrote an hourly row (a data problem);
 * `partial` means fewer than half the window's hours reported; see
 * vision_report_engine.aggregate_camera.
 */
export const STATUS_COLORS = {
  ok: '#22c55e',
  partial: '#f59e0b',
  no_data: '#5b6a86',
}

export const STATUS_LABELS = {
  ok: 'Reporting',
  partial: 'Partial data',
  no_data: 'No data',
}

/**
 * A percent value already in 0..100 space (as the backend sends defect
 * rates, cumulative pareto shares, etc.) → string. `null` means "not
 * measured" and must stay visibly blank — rendering it as 0% would read as a
 * real, perfect quality score.
 */
export function fmtPercent(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function fmtDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

/**
 * True once the rows span more than one data source.
 *
 * Camera identity is `(datasource_id, location, code)` server-side, but only
 * the datasource part is invisible on screen — two plants routinely both have
 * a `Line 1 / CAM01`. Everything that names or keys a camera consults this so
 * the source is shown when it disambiguates and stays out of the way when
 * there is nothing to disambiguate.
 */
export function isMultiSource(rows = []) {
  return new Set(rows.map((r) => r.datasource_id ?? null)).size > 1
}

/**
 * `Line 1 / Packer Cam`, the label used everywhere a camera is named —
 * prefixed with the plant when asked.
 *
 * The prefix rather than a separate column is deliberate: a template's column
 * list is saved per template, so a new column would never appear on any report
 * anyone has already built.
 */
export function cameraLabel(c, withSource = false) {
  const base = `${c.location ?? '—'} / ${c.name ?? c.code ?? '—'}`
  return withSource && c.datasource_name ? `${c.datasource_name} · ${base}` : base
}

/** Stable React key for a camera row. Mirrors `_camera_key` in reports.py. */
export function cameraKey(c) {
  return `${c.datasource_id ?? ''}::${c.location ?? ''}::${c.code ?? ''}`
}

/**
 * Colour a defect-rate percentage against warn/crit thresholds — lower is
 * better, the inverse of a coverage/availability grade. `null` (no data) is
 * neutral rather than alarming: an outage is Camera Summary's "no_data"
 * status to surface, not a quality colour.
 */
export function defectRateColor(ratePct, warnPct = 2, critPct = 5) {
  if (ratePct == null) return 'var(--fg-dim)'
  if (ratePct >= critPct) return 'var(--crit)'
  if (ratePct >= warnPct) return 'var(--warn)'
  return 'var(--ok)'
}
