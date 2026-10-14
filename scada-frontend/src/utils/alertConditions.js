/**
 * Structured alert-condition evaluator for Live panels.
 *
 * Conditions are built in the panel editor from dropdown "blocks" (no typed
 * syntax), so they arrive here as data, not text — there is no parser and no
 * `eval`/`Function`. A condition is a list of comparison rows folded together
 * left-to-right by AND/OR connectors:
 *
 *   { rows: [
 *       { lhs: 'Pressure1', op: '>',  rhsType: 'value',  rhs: 20 },
 *       { lhs: 'Pressure2', op: '>',  rhsType: 'value',  rhs: 20, connector: 'AND' },
 *   ] }
 *
 * `rhsType: 'series'` makes `rhs` another value column of the same row (e.g. P1 > P2).
 * `rhsType: 'panel'` makes `rhs` a column of the panel's table (e.g. a setpoint
 * column), read live from the same row as the series. The first row carries no
 * connector; every later row carries 'AND' | 'OR'.
 *
 * A condition also carries `level: 'warning' | 'critical'` (missing means
 * 'warning'), which is what the alert pill reports.
 */

const EPS = 1e-9

// Panel-column values share the `vars` map with series labels; the prefix keeps
// a column that happens to share a series' name from colliding with it.
export const PANEL_VAR_PREFIX = 'panel:'
export const panelVarKey = (col) => PANEL_VAR_PREFIX + col

const COMPARATORS = {
  '=': (a, b) => Math.abs(a - b) <= EPS,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
}

export const COMPARATOR_OPS = Object.keys(COMPARATORS)

// Lowest to highest; the index is the severity rank.
export const ALERT_LEVELS = ['warning', 'critical']

/** A condition's level, defaulting legacy (level-less) conditions to 'warning'. */
export const levelOf = (condition) => (condition?.level === 'critical' ? 'critical' : 'warning')

/**
 * Resolve both operands of one row. `met` is true only when both are finite
 * numbers and the comparison holds; `rhs` is the number actually compared
 * against (the typed value, the other column's reading, or the live panel
 * column), so a caller can show the limit that was crossed.
 */
export function resolveRow(row, vars) {
  const lhs = vars[row.lhs]
  const rhs = row.rhsType === 'series' ? vars[row.rhs]
    : row.rhsType === 'panel' ? vars[panelVarKey(row.rhs)]
      : Number(row.rhs)
  const cmp = COMPARATORS[row.op]
  const met = !!cmp && Number.isFinite(lhs) && Number.isFinite(rhs) && cmp(lhs, rhs)
  return { met, lhs, rhs }
}

/**
 * Evaluate a condition against a `{ column: latestValue }` map.
 * Rows fold left-to-right; each non-first row applies its own connector.
 */
export function evalCondition(condition, vars) {
  const rows = condition?.rows
  if (!Array.isArray(rows) || !rows.length) return false
  let acc = resolveRow(rows[0], vars).met
  for (let i = 1; i < rows.length; i++) {
    const r = resolveRow(rows[i], vars).met
    acc = rows[i].connector === 'OR' ? acc || r : acc && r
  }
  return acc
}

/** Ordered, de-duped list of every value column a condition references. */
export function conditionRefs(condition) {
  const out = []
  const seen = new Set()
  const add = (name) => {
    if (name && !seen.has(name)) { seen.add(name); out.push(name) }
  }
  for (const r of condition?.rows || []) {
    add(r.lhs)
    if (r.rhsType === 'series') add(r.rhs)
  }
  return out
}

/** Ordered, de-duped table columns referenced by `rhsType: 'panel'` rows. */
export function panelColumnRefs(conditions) {
  const out = []
  const seen = new Set()
  for (const c of conditions || []) {
    for (const r of c?.rows || []) {
      if (r.rhsType === 'panel' && r.rhs && !seen.has(r.rhs)) { seen.add(r.rhs); out.push(r.rhs) }
    }
  }
  return out
}

const rhsLabel = (row) => (row.rhsType === 'panel' ? `${row.rhs} (panel)` : String(row.rhs))

/** One condition as text, for the alert tooltip: "[CRITICAL] value_tag > 250". */
function conditionText(condition) {
  const parts = (condition.rows || []).map((r, i) => (
    `${i ? `${r.connector === 'OR' ? 'OR' : 'AND'} ` : ''}${r.lhs} ${r.op} ${rhsLabel(r)}`
  ))
  return `[${levelOf(condition).toUpperCase()}] ${parts.join(' ')}`
}

/**
 * Alerts per series, evaluated row by row.
 *
 * A table row is one (source, filter value) pair: Temperature1 and
 * Temperature2 share the column `value_tag` but are different rows, so each is
 * judged on its own reading and its own setpoint columns. Within a row every
 * value column is visible to the condition, which is what a `series`
 * comparison (P1 > P2 on the same row) needs.
 *
 * `seriesList` entries: `{ key, valueCol, filterVal, datasourceId, latest, panelCols }`.
 *
 * Returns `{ [series.key]: { level, op, limit, rhsName, text } }` for every
 * series a firing condition references. `level` is the highest among them;
 * `op`/`limit` come from the first met row comparing *this* series' column in
 * the highest-level condition (null when it only appears on a right-hand side);
 * `text` lists every firing condition for a tooltip.
 */
export function seriesAlerts(conditions, seriesList) {
  const out = {}
  if (!Array.isArray(conditions) || !conditions.length) return out

  const rows = new Map()
  for (const s of seriesList || []) {
    const id = JSON.stringify([s.datasourceId ?? null, s.filterVal ?? null])
    let g = rows.get(id)
    if (!g) { g = { vars: {}, series: [] }; rows.set(id, g) }
    g.series.push(s)
    if (s.latest) g.vars[s.valueCol] = s.latest.value
    for (const [col, v] of Object.entries(s.panelCols || {})) g.vars[panelVarKey(col)] = v
  }

  for (const { vars, series } of rows.values()) {
    for (const cond of conditions) {
      if (!evalCondition(cond, vars)) continue
      const refs = new Set(conditionRefs(cond))
      const level = levelOf(cond)
      for (const s of series) {
        if (!refs.has(s.valueCol)) continue
        const prev = out[s.key]
        const text = prev ? `${prev.text}\n${conditionText(cond)}` : conditionText(cond)
        if (prev && ALERT_LEVELS.indexOf(prev.level) >= ALERT_LEVELS.indexOf(level)) {
          prev.text = text
          continue
        }
        const hit = (cond.rows || []).find((r) => r.lhs === s.valueCol && resolveRow(r, vars).met)
        out[s.key] = {
          level,
          op: hit ? hit.op : null,
          limit: hit ? resolveRow(hit, vars).rhs : null,
          rhsName: hit && hit.rhsType !== 'value' ? hit.rhs : null,
          text,
        }
      }
    }
  }
  return out
}
