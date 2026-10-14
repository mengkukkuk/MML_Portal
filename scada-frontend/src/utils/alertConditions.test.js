import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evalCondition, conditionRefs, panelColumnRefs, alertingSeries, panelVarKey,
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
  assert.deepEqual(alertingSeries([cs[1]], { P1: 20, [panelVarKey('sp2')]: 1 }), ['P1'])
})
