/**
 * Shared formatting and palette for the report blocks.
 *
 * The state colours are literal hex rather than `var(--ok)` because ECharts
 * paints to a canvas and cannot resolve CSS custom properties. They are kept
 * in step with tokens.css by hand — if a token moves, move it here too.
 */

export const STATES = ['RUN', 'STOP', 'IDLE', 'PLANNED_DOWN', 'UNKNOWN']

export const STATE_COLORS = {
  RUN: '#22c55e', // --ok
  STOP: '#ef4444', // --crit
  IDLE: '#f59e0b', // --warn
  PLANNED_DOWN: '#3aa0ff', // --info
  UNKNOWN: '#5b6a86', // --fg-dim
}

export const STATE_LABELS = {
  RUN: 'Running',
  STOP: 'Stopped',
  IDLE: 'Idle',
  PLANNED_DOWN: 'Planned down',
  UNKNOWN: 'No data',
}

export const SEVERITY_COLORS = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3aa0ff',
}

/** Seconds → compact human duration, e.g. `2d 4h`, `3h 12m`, `45s`. */
export function fmtDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`

  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)

  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Seconds → `HH:MM:SS`, used where a total has to be auditable. */
export function fmtClock(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/**
 * 0..1 → percent string. A null ratio means "not measured" and must stay
 * visibly blank — rendering it as 0% would read as a real, catastrophic score.
 */
export function fmtPct(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function fmtDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

/**
 * True once the rows span more than one data source.
 *
 * Machine identity is `(datasource_id, location, tag_name)` server-side, but
 * only the datasource part is invisible on screen — two plants routinely both
 * have a `Line 1 / M01`. Everything that names or keys a machine consults this
 * so the source is shown when it disambiguates and stays out of the way when
 * there is nothing to disambiguate.
 */
export function isMultiSource(rows = []) {
  return new Set(rows.map((r) => r.datasource_id ?? null)).size > 1
}

/**
 * `Line 1 / M01`, the label used everywhere a machine is named — prefixed with
 * the plant when asked.
 *
 * The prefix rather than a separate column is deliberate: a template's column
 * list is saved per template, so a new column would never appear on any report
 * anyone has already built.
 */
export function machineLabel(m, withSource = false) {
  const base = `${m.location ?? '—'} / ${m.tag_name ?? '—'}`
  return withSource && m.datasource_name ? `${m.datasource_name} · ${base}` : base
}

/** Stable React key for a machine row. Mirrors `_machine_key` in reports.py. */
export function machineKey(m) {
  return `${m.datasource_id ?? ''}::${m.location ?? ''}::${m.tag_name ?? ''}`
}

/**
 * Colour an availability figure against a target band. Used by the KPI strip
 * and the summary table so both grade a number the same way.
 */
export function gradeColor(ratio, target = 0.85) {
  if (ratio == null) return 'var(--fg-dim)'
  if (ratio >= target) return 'var(--ok)'
  if (ratio >= target - 0.1) return 'var(--warn)'
  return 'var(--crit)'
}

/** The caveat that has to survive onto every screenshot, print and export. */
export const OEE_CAVEAT =
  'OEE is Availability only — this plant logs no production or reject counts, ' +
  'so Performance and Quality are assumed 100%.'
