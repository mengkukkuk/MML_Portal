/**
 * kpiView — pure view-model helpers for the Live management blocks
 * (Loss meter, Andon board, Loss waterfall). Formatting, geometry and labels
 * only; every number comes from `/api/kpi/summary` (kpi.py), which is where the
 * loss rules live. No React here, so kpiView.test.js runs under `node --test`.
 */
import { groupDigits } from '../../utils/numberFormat.js'

/** Andon colour tokens per state. `off` is an unscheduled stop (idle night). */
export const STATE_TOKENS = Object.freeze({
  run: 'var(--ok)',
  slow: 'var(--warn)',
  stop: 'var(--crit)',
  nodata: 'var(--fg-dim)',
  off: 'transparent',
})

/** English keys (src/i18n translates them); Thai shown in Thai mode. */
export const STATE_LABELS = Object.freeze({
  run: 'Running',
  slow: 'Slow',
  stop: 'Stopped',
  nodata: 'No data',
  off: 'Not scheduled',
})

export const LOSSMETER_TITLES = Object.freeze({
  defects: 'Defect cost',
  lost: 'Production lost',
  total: 'Total loss',
})

/** Whole pieces, digits grouped. */
export function fmtPieces(n) {
  return Number.isFinite(n) ? groupDigits(Math.round(n), 0) : '—'
}

/** ฿ with grouped digits, no decimals — the board reads magnitudes, not satang. */
export function fmtBaht(n) {
  return Number.isFinite(n) ? `฿${groupDigits(Math.round(n), 0)}` : '—'
}

/** Minutes → "12 min" / "5 h 20 min" / "2 d 3 h", via the translator. */
export function fmtDuration(minutes, tr = (s, p) => s.replace(/\{(\w+)\}/g, (_, k) => p[k])) {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return tr('{m} min', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? tr('{h} h {m} min', { h, m: m % 60 }) : tr('{h} h', { h })
  return tr('{d} d {h} h', { d: Math.floor(h / 24), h: h % 24 })
}

/** Minutes since `since` (ISO string or Date) at `now` (ms). */
export function minutesSince(since, now = Date.now()) {
  const t = since ? Date.parse(since) : NaN
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : null
}

/**
 * The headline of a Loss meter for its mode: pieces always, ฿ when visible.
 * `pending` is the cost of a stop still in progress, not yet counted.
 */
export function lossMeterFigures(summary, mode = 'defects') {
  const t = summary?.totals
  if (!t) return null
  const pieces = mode === 'defects' ? t.defects : mode === 'lost' ? t.lost : t.defects + t.lost
  const baht = t.baht
    ? (mode === 'defects' ? t.baht.defects : mode === 'lost' ? t.baht.lost : t.baht.total)
    : null
  const prev = summary.compare
  const prevPieces = prev
    ? (mode === 'defects' ? prev.defects : mode === 'lost' ? prev.lost : prev.defects + prev.lost)
    : null
  const prevBaht = prev?.baht
    ? (mode === 'defects' ? prev.baht.defects : mode === 'lost' ? prev.baht.lost : prev.baht.total)
    : null
  return {
    pieces,
    baht,
    pendingPieces: mode === 'defects' ? 0 : t.pending,
    pendingBaht: mode === 'defects' || !t.baht ? null : t.baht.pending,
    deltaPieces: prevPieces == null ? null : pieces - prevPieces,
    deltaBaht: prevBaht == null || baht == null ? null : baht - prevBaht,
  }
}

/** Arrow and tone for a change in a *loss*: up is worse. */
export function lossDelta(delta) {
  if (delta == null || !Number.isFinite(delta)) return null
  if (Math.round(delta) === 0) return { arrow: '=', tone: 'flat' }
  return delta > 0 ? { arrow: '▲', tone: 'bad' } : { arrow: '▼', tone: 'good' }
}

/**
 * The Loss meter's faint running-total sparkline. The summary carries totals
 * only, so the line is built from successive polls: append `value` at `t`,
 * keep the last `max` points, and restart when the value falls (a new period
 * began).
 */
export function appendSpark(points, t, value, max = 240) {
  if (!Number.isFinite(value)) return points
  const last = points[points.length - 1]
  if (last && value < last[1]) return [[t, value]]
  if (last && last[0] === t) return points
  const next = [...points, [t, value]]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Vertical waterfall geometry, in fractions of the potential (0..1).
 *
 * Potential is a full bar; each loss floats below the remaining level; good is
 * a full bar from zero. `largest` flags the biggest loss so the eye lands on it.
 */
export function waterfallBars(totals) {
  if (!totals) return []
  const potential = totals.potential || 0
  const scale = potential > 0 ? potential : 1
  const steps = [
    { key: 'potential', label: 'Possible output', value: potential, kind: 'base' },
    { key: 'stop_loss', label: 'Stops', value: totals.stop_loss || 0, kind: 'loss' },
    { key: 'slow_loss', label: 'Running slow', value: totals.slow_loss || 0, kind: 'loss' },
    { key: 'defects', label: 'Defects', value: totals.defects || 0, kind: 'loss' },
    { key: 'good', label: 'Good output', value: totals.good || 0, kind: 'good' },
  ]
  const biggest = Math.max(...steps.filter((s) => s.kind === 'loss').map((s) => s.value))
  let remaining = potential
  return steps.map((s) => {
    let bottom = 0
    if (s.kind === 'loss') {
      remaining -= s.value
      bottom = remaining
    }
    return {
      ...s,
      bottom: Math.max(0, bottom) / scale,
      height: Math.max(0, s.value) / scale,
      // where the dashed connector to the next bar sits
      level: (s.kind === 'base' ? potential : s.kind === 'loss' ? remaining : s.value) / scale,
      largest: s.kind === 'loss' && s.value > 0 && s.value === biggest,
    }
  })
}

/** The 24 h strip as [{state, pct}] left to right. */
export function stripSegments(strip, now = Date.now()) {
  if (!strip?.length) return []
  const start = Date.parse(strip[0].start)
  const end = Math.max(Date.parse(strip[strip.length - 1].end), now)
  const span = end - start
  if (!(span > 0)) return []
  return strip.map((s) => ({
    state: s.state,
    pct: (100 * (Date.parse(s.end) - Date.parse(s.start))) / span,
  }))
}

/** The state word on an Andon tile: "Stopped 12 min" for a stop, plain otherwise. */
export function andonWord(family, tr, now = Date.now()) {
  const label = tr(STATE_LABELS[family?.state] ?? 'No data')
  if (family?.state !== 'stop') return label
  const mins = minutesSince(family.state_since, now)
  return mins == null ? label : `${label} ${fmtDuration(mins, tr)}`
}
