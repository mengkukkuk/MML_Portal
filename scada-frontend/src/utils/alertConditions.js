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
 * `rhsType: 'series'` makes `rhs` another series label (e.g. P1 > P2). The
 * first row carries no connector; every later row carries 'AND' | 'OR'.
 */

const EPS = 1e-9

const COMPARATORS = {
  '=': (a, b) => Math.abs(a - b) <= EPS,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
}

export const COMPARATOR_OPS = Object.keys(COMPARATORS)

// True only when both operands resolve to finite numbers and the comparison holds.
function evalRow(row, vars) {
  const lhs = vars[row.lhs]
  const rhs = row.rhsType === 'series' ? vars[row.rhs] : Number(row.rhs)
  const cmp = COMPARATORS[row.op]
  if (!cmp || !Number.isFinite(lhs) || !Number.isFinite(rhs)) return false
  return cmp(lhs, rhs)
}

/**
 * Evaluate a condition against a `{ seriesLabel: latestValue }` map.
 * Rows fold left-to-right; each non-first row applies its own connector.
 */
export function evalCondition(condition, vars) {
  const rows = condition?.rows
  if (!Array.isArray(rows) || !rows.length) return false
  let acc = evalRow(rows[0], vars)
  for (let i = 1; i < rows.length; i++) {
    const r = evalRow(rows[i], vars)
    acc = rows[i].connector === 'OR' ? acc || r : acc && r
  }
  return acc
}

/** Ordered, de-duped list of every series label a condition references. */
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

/**
 * Union (first-seen order, de-duped) of the referenced series of every
 * condition that evaluates true. This is the panel's merged alert pill list —
 * a subset condition's series simply fold into a wider one's, so {P1} and
 * {P1,P2} collapse to {P1,P2}.
 */
export function alertingSeries(conditions, vars) {
  const out = []
  const seen = new Set()
  for (const c of conditions || []) {
    if (!evalCondition(c, vars)) continue
    for (const name of conditionRefs(c)) {
      if (!seen.has(name)) { seen.add(name); out.push(name) }
    }
  }
  return out
}
