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

// --- second set: KPI strip, hourly rate, plan pace, sensors, trend, Pareto ---------

const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—')

/**
 * The KPI strip's catalogue: label (i18n key), how to print the value, the
 * sub-line, and the tone — `bad` when the number is a problem, so the board
 * reads colour before digits. Keys match `metrics` in /kpi/summary. A sub-line
 * is an i18n key, or [key, params] when it carries a number.
 */
export const METRIC_META = Object.freeze({
  plan_pct: {
    label: 'Good vs plan', fmt: (m) => pct(m.plan_pct),
    sub: (m, s) => (s?.plan ? `${fmtPieces(m.good)} / ${fmtPieces(s.plan.to_date)}` : 'set a plan in block settings'),
    tone: (m) => (m.plan_pct != null && m.plan_pct < 0.95 ? 'warn' : null),
  },
  yield: { label: 'Yield', fmt: (m) => pct(m.yield), sub: (m) => ['{n} defects', { n: fmtPieces(m.defects) }], tone: () => null },
  availability: {
    label: 'Running time', fmt: (m) => pct(m.availability, 0),
    sub: (m) => (m.stop_min != null ? ['stopped {m} min', { m: m.stop_min }] : null),
    tone: (m) => (m.availability != null && m.availability < 0.85 ? 'warn' : null),
  },
  risk_pieces: {
    label: 'Pieces at risk', fmt: (m) => fmtPieces(m.risk_pieces),
    sub: () => 'made while a sensor was out or frozen', tone: (m) => (m.risk_pieces > 0 ? 'bad' : null),
  },
  blind_min: {
    label: 'Blind time', fmt: (m) => (m.blind_min == null ? '—' : `${m.blind_min}`),
    sub: () => 'min, sensor frozen or missing', tone: (m) => (m.blind_min > 0 ? 'warn' : null),
  },
  avg_response_min: {
    label: 'Response time', fmt: (m) => (m.avg_response_min == null ? '—' : `${Math.round(m.avg_response_min)}`),
    sub: (m) => (m.incidents != null ? ['min · {n} incidents', { n: m.incidents }] : 'min'), tone: () => null,
  },
  good: { label: 'Good pieces', fmt: (m) => fmtPieces(m.good), sub: () => null, tone: () => null },
  pieces: { label: 'Pieces made', fmt: (m) => fmtPieces(m.pieces), sub: () => null, tone: () => null },
  defects: { label: 'Defects', fmt: (m) => fmtPieces(m.defects), sub: (m) => pct(m.defect_rate), tone: () => null },
  defect_rate: { label: 'Defect rate', fmt: (m) => pct(m.defect_rate, 2), sub: (m) => ['{n} pcs', { n: fmtPieces(m.defects) }], tone: () => null },
  lost: {
    label: 'Production lost', fmt: (m) => fmtPieces(m.lost),
    sub: () => 'pcs, stops and slow running', tone: (m) => (m.lost > 0 ? 'bad' : null),
  },
  cost_total: {
    label: 'Total loss', fmt: (m) => (m.baht ? fmtBaht(m.baht.cost_total) : '—'),
    sub: () => 'defects + production lost', tone: () => 'bad',
  },
  incidents: {
    label: 'Out-of-band incidents', fmt: (m) => (m.incidents == null ? '—' : `${m.incidents}`),
    sub: () => 'this period', tone: (m) => (m.incidents > 0 ? 'warn' : null),
  },
})

/** The tiles a strip shows, dropping money tiles for viewers without cost. */
export function stripTiles(summary) {
  const m = summary?.metrics
  if (!m) return []
  const keys = summary.settings?.metrics || []
  return keys
    .filter((k) => METRIC_META[k] && (k !== 'cost_total' || m.baht))
    .map((k) => {
      const meta = METRIC_META[k]
      return { key: k, label: meta.label, value: meta.fmt(m), sub: meta.sub(m, summary), tone: meta.tone(m) }
    })
}

/**
 * Hourly (or daily) defect-rate bars: height as a share of the tallest, and
 * `above` for buckets worse than the period's own average — the dashboard's
 * "red = above the shift average" rule.
 */
export function hourlyBars(rows) {
  const used = (rows || []).filter((r) => r.pieces > 0)
  const pieces = used.reduce((s, r) => s + r.pieces, 0)
  const avg = pieces ? used.reduce((s, r) => s + r.defects, 0) / pieces : null
  const max = Math.max(0, ...used.map((r) => r.rate || 0))
  return {
    avg,
    max,
    bars: (rows || []).map((r) => ({
      start: r.start,
      rate: r.rate,
      pieces: r.pieces,
      defects: r.defects,
      share: max > 0 && r.rate != null ? r.rate / max : 0,
      above: avg != null && r.rate != null && r.rate > avg,
      empty: !(r.pieces > 0),
    })),
  }
}

/**
 * Plan-pace geometry in a 0..1 box: cumulative good (the line), the plan (a
 * dashed line, when there is one), "could have made" (cumulative potential),
 * and the stopped / no-data bands behind them. x runs over the whole period
 * so the rest of the day shows as space still to cover.
 */
export function paceGeometry(summary) {
  const rows = summary?.timeline?.rows || []
  const p = summary?.period
  if (!rows.length || !p) return null
  const t0 = Date.parse(p.start)
  const t1 = Date.parse(p.full_end || p.end)
  const span = t1 - t0 || 1
  const size = (summary.timeline.size_min || 5) * 60000
  const top = Math.max(1, ...rows.map((r) => Math.max(r.good_cum, r.potential_cum, r.plan_cum ?? 0)),
    summary.plan?.total ?? 0)
  const x = (t) => (t - t0) / span
  const pt = (r, key) => [x(Date.parse(r.start) + size), (r[key] ?? 0) / top]
  return {
    top,
    good: rows.map((r) => pt(r, 'good_cum')),
    potential: rows.map((r) => pt(r, 'potential_cum')),
    plan: summary.plan ? [[0, 0], [1, summary.plan.total / top]] : null,
    bands: rows
      .filter((r) => r.state === 'stop' || r.state === 'nodata')
      .map((r) => ({ state: r.state, x: x(Date.parse(r.start)), w: size / span })),
    last: rows[rows.length - 1],
  }
}

/** Sensor states → colour for the strip (ok is quiet on purpose). */
export const SENSOR_TOKENS = Object.freeze({
  ok: 'color-mix(in srgb, var(--fg) 14%, transparent)',
  out: 'var(--crit)',
  flat: 'var(--warn)',
  missing: 'transparent',
})

export const SENSOR_LABELS = Object.freeze({
  ok: 'Normal', out: 'Out of low–high', flat: 'Frozen value', missing: 'No data',
})

/** Today vs yesterday for one trend metric: up is good unless `goodUp` is false. */
export function trendDelta(days, key, goodUp = true) {
  const vals = (days || []).map((d) => d[key])
  const last = vals[vals.length - 1]
  const prev = vals[vals.length - 2]
  if (last == null || prev == null) return { last, prev, worse: false }
  return { last, prev, worse: goodUp ? last < prev : last > prev }
}

// --- Response board: alert events and who must act ----------------------------------

/** Severity words (i18n keys), worst first. */
export const SEVERITY_LABELS = Object.freeze({ crit: 'Critical', warn: 'Warning', info: 'Info' })

/**
 * How an event reached its owner, as [i18n key, params, tone]. A catch-all
 * with a location is flagged: that location has no rule of its own, which is
 * usually a spelling the rules do not know ("L13" against "Line 13").
 */
export function viaNote(ev) {
  const l = ev?.location
  switch (ev?.via) {
    case 'tag': return ['set on the alert row', {}, null]
    case 'location': return ['rule for {l}', { l }, null]
    case 'catch_all':
      return l ? ['no rule for {l} · global', { l }, 'warn'] : ['global rule', {}, null]
    default: return ['no rule matches', {}, 'bad']
  }
}

/** "09:12" for one alert, "09:12–09:34" for a run of them; the date once the period spans days. */
export function eventWhen(ev, withDate, locale = []) {
  if (!ev?.start) return '—'
  const t = (iso, date) => new Date(iso).toLocaleString(locale, {
    ...(date ? { day: 'numeric', month: 'numeric' } : {}), hour: '2-digit', minute: '2-digit',
  })
  const first = t(ev.start, withDate)
  return ev.count > 1 && ev.end && ev.end !== ev.start ? `${first}–${t(ev.end, false)}` : first
}
