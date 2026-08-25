/**
 * tagStatus — the vocabulary every mimic tag is described in, shared by the
 * demo simulator and the live poller.
 *
 * These four helpers used to live in mockPlant.js, which made the live path
 * import the simulator just to format a number. They belong here: a tag entry
 * has the same shape whichever source produced it, so status, formatting and
 * flow are properties of the shape, not of where it came from.
 *
 * A tag entry (one per node, keyed by node id):
 *
 *   { id, label, value, prevValue, display, prevDisplay, state, status,
 *     prevStatus, unit, decimals, kind, range: [lo, hi] | null,
 *     limits: { warnLo, warnHi, critLo, critHi }, pulse, ts }
 *
 * Analog tags leave `state` null, discrete tags leave `value` null, and a pump
 * carries both.
 */

const STATUS_RANK = {
  normal: 0, stale: 1, warn: 2, crit: 3,
}

/** The worse of two statuses — how a plant-wide status is reduced. */
export function worseStatus(a, b) {
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a
}

/**
 * Status of a numeric reading against its four limits. Any limit may be null
 * (an unbound or partly configured tag simply can't reach that state).
 * `limits` is the `{ warnLo, warnHi, critLo, critHi }` shape — the simulator's
 * tag definitions carry those keys at the top level, so a TAG_DEFS entry can be
 * passed straight in.
 */
export function analogStatus(limits, value) {
  if (value == null || !limits) return 'normal'
  if (limits.critLo != null && value <= limits.critLo) return 'crit'
  if (limits.critHi != null && value >= limits.critHi) return 'crit'
  if (limits.warnLo != null && value <= limits.warnLo) return 'warn'
  if (limits.warnHi != null && value >= limits.warnHi) return 'warn'
  return 'normal'
}

/**
 * True when a reading is a number a symbol can actually print or scale.
 *
 * `/api/schema/latest` types its value as a float, so this is not about the
 * column — it is about what survives the trip. A per-binding `expr` can produce
 * NaN or Infinity (`value/0`, `sqrt` of a negative), a row can be missing, and a
 * discrete-only binding never carries a number at all. A readout that renders
 * those as "NaN" looks like a reading, which is the one thing it must not do.
 */
export function isNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The token a named state is drawn in, or null for a name this vocabulary does
 * not know. Null is not a failure: it means "colour this by status instead",
 * which is what an admin who typed their own map labels will expect.
 *
 * The names come from two places and both are open sets — `state.map` is free
 * text an admin types into the binding dialog, and `threshold` mode yields
 * run/stop. So this matches the conventional words rather than pretending to be
 * exhaustive.
 */
const STATE_TOKENS = {
  red: 'var(--crit)',
  crit: 'var(--crit)',
  alarm: 'var(--crit)',
  fault: 'var(--crit)',
  trip: 'var(--crit)',
  amber: 'var(--warn)',
  yellow: 'var(--warn)',
  warn: 'var(--warn)',
  green: 'var(--ok)',
  ok: 'var(--ok)',
  run: 'var(--ok)',
  open: 'var(--ok)',
  stop: 'var(--fg-dim)',
  off: 'var(--fg-dim)',
  closed: 'var(--fg-dim)',
  idle: 'var(--fg-dim)',
}

export function stateColor(state) {
  if (!state) return null
  return STATE_TOKENS[String(state).toLowerCase()] ?? null
}

/** The token a derived status is drawn in. Always answers. */
export function statusColor(status) {
  if (status === 'crit') return 'var(--crit)'
  if (status === 'warn') return 'var(--warn)'
  if (status === 'stale') return 'var(--fg-dim)'
  return 'var(--ok)'
}

/** Formats a tag's live number for a readout. Never returns undefined. */
export function formatValue(tag) {
  if (!tag) return '—'
  if (tag.display == null) return tag.state ? tag.state.toUpperCase() : '—'
  return tag.display.toFixed(tag.decimals ?? 0)
}

/**
 * True when a drive/flow tag is actively moving product.
 *
 * A missing tag reads as flowing on purpose: an unbound pipe is drawn as part
 * of the plant, not as a stopped one, and freezing every line on a fresh
 * uncommissioned drawing would read as a fault that isn't there.
 */
export function isFlowing(tag) {
  if (!tag) return true
  if (tag.state) return tag.state !== 'stop' && tag.state !== 'closed'
  return tag.value == null || tag.value > 0
}
