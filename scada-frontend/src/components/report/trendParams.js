/**
 * URL round-trip for the trend binding — table, column, timestamp, device.
 *
 * Kept apart from `reportRange`'s filter params rather than folded into them.
 * Both write to the same query string, but they answer different questions and
 * neither should be able to invalidate the other: `filtersFromParams` reads only
 * the keys it knows, so trend keys pass through it untouched, and vice versa.
 * `mergeParams` below is what keeps a write from one side wiping the other.
 *
 * The point of putting any of it in the URL is the same as for the report
 * filters: a trend someone found is a link, not a screenshot plus instructions.
 */

// The four slots a numeric-array reading carries, in the order the plant writes
// them. Index *is* meaning here — there is no per-row label to read it from.
export const ROLES = [
  { key: 'value', index: 0, label: 'Value' },
  { key: 'setpoint', index: 1, label: 'Setpoint' },
  { key: 'high', index: 2, label: 'High limit' },
  { key: 'low', index: 3, label: 'Low limit' },
]

export const ALL_INDEXES = ROLES.map((r) => r.index)

// Which slot a *comparison* is about. Several readings on one chart can only be
// compared on the thing being measured — N setpoints or N limit lines overlaid
// answer nothing — so the multi-column mode plots this slot and only this slot.
// It is the plant's own `defect_n[1]`: Postgres subscripts from 1, JS from 0.
export const VALUE_INDEX = 0

export const DEFAULT_MINUTES = 480

// The two vocabularies sharing the query string. Listed together here because
// coexistence is this module's job: each writer clears its own keys and leaves
// the other's alone, and neither has to import the other to do it.
//
// 'fcol'/'fval' are listed but no longer read or written: the device filter has
// no control any more, and leaving them in `owns` is what purges the pair from
// an older link rather than leaving a filter nothing on screen can undo.
export const TREND_KEYS = ['tbl', 'vcol', 'tscol', 'fcol', 'fval', 'win', 'idx', 'tstart', 'tend']
export const FILTER_KEYS = ['preset', 'start', 'end', 'location', 'tag']

export const EMPTY_TREND = {
  table: '',
  valueCols: [],
  tsCol: '',
  minutes: DEFAULT_MINUTES,
  indexes: ALL_INDEXES,
}

/** A trend is only runnable once it has somewhere to read from and a clock. */
export function isPlottable(trend) {
  return !!(trend?.table && trend?.valueCols?.length && trend?.tsCol)
}

/**
 * Several readings on one chart, which is a different chart.
 *
 * One column is an envelope — a value against its own setpoint and limits.
 * Two or more are a comparison, and the roles stop applying: the second
 * column's limits are not the first column's. Every consumer branches on this
 * rather than generalising, so the one-column chart is left exactly as it was.
 */
export function isMultiReading(trend) {
  return (trend?.valueCols?.length ?? 0) > 1
}

function parseIndexes(raw) {
  if (raw == null) return ALL_INDEXES
  // Every role toggled off is a legitimate state, so it needs a spelling of its
  // own — an empty value is indistinguishable from an absent one, and would
  // come back as "show everything".
  if (raw === 'none') return []
  const wanted = raw
    .split(',')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => ALL_INDEXES.includes(n))
  // A link naming no *valid* index is corrupt rather than empty; drawing
  // nothing would read as "this device has no data".
  return wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : ALL_INDEXES
}

export function trendFromParams(params) {
  const minutes = Number.parseInt(params.get('win') ?? '', 10)
  return {
    table: params.get('tbl') ?? '',
    // Repeated rather than comma-joined, the way `location` and `tag` already
    // are: a column name is a plant's identifier and nothing here gets to
    // reserve a character in it. `getAll` reads a single-`vcol` link — every
    // link shared before this — back as a one-element selection unchanged.
    valueCols: params.getAll('vcol').filter(Boolean),
    tsCol: params.get('tscol') ?? '',
    minutes: params.get('win') === 'custom' ? 'custom'
      : [10, 30, 60, 480, 1440, 10080].includes(minutes) ? minutes : DEFAULT_MINUTES,
    start: params.get('tstart') ?? '',
    end: params.get('tend') ?? '',
    indexes: parseIndexes(params.get('idx')),
  }
}

export function paramsFromTrend(trend) {
  const out = new URLSearchParams()
  if (!trend) return out
  if (trend.table) out.set('tbl', trend.table)
  ;(trend.valueCols ?? []).forEach((col) => { if (col) out.append('vcol', col) })
  if (trend.tsCol) out.set('tscol', trend.tsCol)
  if (trend.minutes !== DEFAULT_MINUTES) out.set('win', String(trend.minutes))
  if (trend.minutes === 'custom') {
    if (trend.start) out.set('tstart', trend.start)
    if (trend.end) out.set('tend', trend.end)
  }
  // Only when it differs from "show everything", so the common case stays a
  // short link.
  const idx = trend.indexes ?? ALL_INDEXES
  // Spelled 'none' rather than left empty: an empty value round-trips as
  // "unset", which parseIndexes reads back as everything.
  if (idx.length !== ALL_INDEXES.length) out.set('idx', idx.length ? idx.join(',') : 'none')
  return out
}

/**
 * Overlay `next` onto `current`, dropping the `owns` keys it no longer sets.
 *
 * `setSearchParams` replaces the whole query string, so whichever control wrote
 * last would otherwise erase the other's keys — picking a date range would clear
 * the chart binding. Each writer passes its own fresh params plus the live
 * `searchParams`, and this keeps both.
 */
export function mergeParams(current, next, owns) {
  const out = new URLSearchParams(current)
  owns.forEach((k) => out.delete(k))
  // Appended, not set: `location` and `tag` are repeated keys, and `set` would
  // collapse a three-line filter down to its last line.
  next.forEach((v, k) => out.append(k, v))
  return out
}
