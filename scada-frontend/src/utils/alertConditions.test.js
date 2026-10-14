import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evalCondition, conditionRefs, panelColumnRefs, seriesAlerts, panelVarKey, levelOf,
} from './alertConditions.js'

const row = (extra) => ({ lhs: 'P1', op: '>', rhsType: 'value', rhs: 10, ...extra })

test('value and series comparators still work', () => {
  assert.equal(evalCondition({ rows: [row()] }, { P1: 11 }), true)
  assert.equal(evalCondition({ rows: [row({ rhsType: 'series', rhs: 'P2' })] }, { P1: 5, P2: 6 }), false)
})

test('panel comparator reads the prefixed column value', () => {
  const c = { rows: [row({ rhsType: 'panel', rhs: 'sp_warn' })] }
  assert.equal(evalCondition(c, { P1: 12, [panelVarKey('sp_warn')]: 10 }), true)
  assert.equal(evalCondition(c, { P1: 8, [panelVarKey('sp_warn')]: 10 }), false)
})

test('a series named like the column does not satisfy a panel row', () => {
  const c = { rows: [row({ rhsType: 'panel', rhs: 'sp_warn' })] }
  assert.equal(evalCondition(c, { P1: 12, sp_warn: 1 }), false)
})

test('missing or non-finite panel value is false', () => {
  const c = { rows: [row({ rhsType: 'panel', rhs: 'sp' })] }
  assert.equal(evalCondition(c, { P1: 12 }), false)
  assert.equal(evalCondition(c, { P1: 12, [panelVarKey('sp')]: NaN }), false)
})

test('panel rows fold with AND / OR', () => {
  const c = { rows: [row(), row({ rhsType: 'panel', rhs: 'sp', connector: 'OR', lhs: 'P2' })] }
  assert.equal(evalCondition(c, { P1: 1, P2: 9, [panelVarKey('sp')]: 5 }), true)
  assert.equal(evalCondition(c, { P1: 1, P2: 3, [panelVarKey('sp')]: 5 }), false)
})

test('conditionRefs excludes panel columns; panelColumnRefs de-dupes', () => {
  const cs = [
    { rows: [row({ rhsType: 'panel', rhs: 'sp' }), row({ connector: 'AND', rhsType: 'panel', rhs: 'sp', lhs: 'P2' })] },
    { rows: [row({ rhsType: 'panel', rhs: 'sp2' })] },
  ]
  assert.deepEqual(conditionRefs(cs[0]), ['P1', 'P2'])
  assert.deepEqual(panelColumnRefs(cs), ['sp', 'sp2'])
  assert.deepEqual(panelColumnRefs(undefined), [])
})

// Two tags sharing one value column through a filter column, like a gauge panel.
const tag = (filterVal, value, panelCols = null, valueCol = 'value_tag') => ({
  key: JSON.stringify([null, JSON.stringify([valueCol, filterVal])]),
  valueCol, filterVal, datasourceId: null, latest: { value }, panelCols,
})
const cond = (level, ...rows) => ({ level, rows })
const r = (op, rhsType, rhs, extra = {}) => ({ lhs: 'value_tag', op, rhsType, rhs, ...extra })

test('levelOf defaults legacy conditions to warning', () => {
  assert.equal(levelOf({ rows: [] }), 'warning')
  assert.equal(levelOf({ level: 'critical' }), 'critical')
  assert.equal(levelOf({ level: 'bogus' }), 'warning')
})

test('each filter series alerts on its own value', () => {
  const t1 = tag('Temperature1', 280)
  const t2 = tag('Temperature2', 120)
  const out = seriesAlerts([cond('warning', r('>', 'value', 150))], [t1, t2])
  assert.deepEqual(Object.keys(out), [t1.key])
  assert.equal(out[t1.key].level, 'warning')
  assert.equal(out[t1.key].op, '>')
  assert.equal(out[t1.key].limit, 150)
})

test('panel columns are read per row', () => {
  const t1 = tag('Temperature1', 200, { sp_warn: 150 })
  const t2 = tag('Temperature2', 200, { sp_warn: 250 })
  const out = seriesAlerts([cond('warning', r('>', 'panel', 'sp_warn'))], [t1, t2])
  assert.deepEqual(Object.keys(out), [t1.key])
  assert.equal(out[t1.key].limit, 150)
  assert.equal(out[t1.key].rhsName, 'sp_warn')
})

test('highest level wins and its limit is reported', () => {
  const t1 = tag('Temperature1', 280)
  const t2 = tag('Temperature2', 255)
  const conds = [cond('warning', r('>', 'value', 150)), cond('critical', r('>', 'value', 260))]
  const out = seriesAlerts(conds, [t1, t2])
  assert.equal(out[t1.key].level, 'critical')
  assert.equal(out[t1.key].limit, 260)
  assert.match(out[t1.key].text, /\[WARNING\][\s\S]*\[CRITICAL\]/)
  assert.equal(out[t2.key].level, 'warning')
  assert.equal(out[t2.key].limit, 150)
})

test('a lower level after a higher one does not downgrade', () => {
  const t1 = tag('Temperature1', 280)
  const conds = [cond('critical', r('>', 'value', 260)), cond('warning', r('>', 'value', 150))]
  const out = seriesAlerts(conds, [t1])
  assert.equal(out[t1.key].level, 'critical')
  assert.equal(out[t1.key].limit, 260)
})

test('series comparison sees only the same row', () => {
  const a1 = tag('M1', 10, null, 'P1')
  const b1 = tag('M1', 5, null, 'P2')
  const a2 = tag('M2', 1, null, 'P1')
  const b2 = tag('M2', 9, null, 'P2')
  const c = cond('critical', { lhs: 'P1', op: '>', rhsType: 'series', rhs: 'P2' })
  const out = seriesAlerts([c], [a1, b1, a2, b2])
  assert.deepEqual(Object.keys(out).sort(), [a1.key, b1.key].sort())
  assert.equal(out[a1.key].limit, 5)
  // P2 only appears on the right-hand side: level only, no limit.
  assert.equal(out[b1.key].op, null)
})

test('no conditions or no readings means no alerts', () => {
  assert.deepEqual(seriesAlerts(undefined, [tag('T', 1)]), {})
  const noData = { ...tag('T', 1), latest: null }
  assert.deepEqual(seriesAlerts([cond('warning', r('>', 'value', 0))], [noData]), {})
})
