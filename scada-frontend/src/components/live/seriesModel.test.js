import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cleanSlots, deriveSeriesSpecs, groupBySource, hasPlottableSeries, isDefaultSlots,
  pickSlot, pruneArraySlots, slotsOf,
} from './seriesModel.js'

/**
 * The risk in widening the series model is silently changing what an existing
 * panel draws, so the first cases pin the legacy output; the rest cover each
 * new option on its own and the way they combine.
 */

const keysOf = (specs) => specs.map((s) => s.key)

test('a panel without the new options draws exactly the legacy series', () => {
  const specs = deriveSeriesSpecs({
    metric: 'value', valueCols: ['rate'], filterCol: 'tag', filters: ['A', 'B'],
    columnLabels: { A: 'Line A' },
  })
  assert.deepEqual(keysOf(specs), [
    '["value","A"]', '["value","B"]', '["rate","A"]', '["rate","B"]',
  ])
  assert.deepEqual(specs.map((s) => s.label), [
    'value · Line A', 'value · B', 'rate · Line A', 'rate · B',
  ])
  assert.deepEqual(specs.map((s) => s.unitKey), ['A', 'B', 'A', 'B'])
  assert.ok(specs.every((s) => s.slot === null && !s.isText && !s.unsplit))
})

test('one column, one filter value labels by the filter value', () => {
  const [spec] = deriveSeriesSpecs({ metric: 'v', filterCol: 'tag', filters: ['A'] })
  assert.equal(spec.label, 'A')
  assert.equal(spec.unitKey, 'A')
})

test('without a filter column each column is one series named by itself', () => {
  const specs = deriveSeriesSpecs({ metric: 'a', valueCols: ['b'], columnLabels: { b: 'Beta' } })
  assert.deepEqual(specs.map((s) => [s.key, s.label]), [['["a",null]', 'a'], ['["b",null]', 'Beta']])
})

test('an unsplit column is drawn once and reads without a filter value', () => {
  const specs = deriveSeriesSpecs({
    metric: 'value', valueCols: ['setpoint'], filterCol: 'tag', filters: ['A', 'B'],
    unsplitCols: ['setpoint'],
  })
  assert.deepEqual(keysOf(specs), ['["value","A"]', '["value","B"]', '["setpoint",null]'])
  const unsplit = specs[2]
  assert.equal(unsplit.filterVal, null)
  assert.equal(unsplit.unsplit, true)
  assert.equal(unsplit.unitKey, 'setpoint')
  assert.equal(unsplit.label, 'setpoint')
  assert.equal(specs[0].unsplit, false)
})

test('unsplit means nothing while no series values are chosen', () => {
  const specs = deriveSeriesSpecs({
    metric: 'a', valueCols: ['b'], filterCol: 'tag', filters: [], unsplitCols: ['b'],
  })
  assert.ok(specs.every((s) => !s.unsplit))
})

test('mapped array slots draw one series each, named by the user', () => {
  const specs = deriveSeriesSpecs({
    metric: 'reading',
    arraySlots: { reading: [{ index: 2, name: 'Upper limit' }, { index: 0, name: 'Measured' }] },
  })
  assert.deepEqual(keysOf(specs), ['["reading",null,0]', '["reading",null,2]'])
  assert.deepEqual(specs.map((s) => s.label), ['Measured', 'Upper limit'])
  assert.deepEqual(specs.map((s) => s.slot), [0, 2])
  assert.deepEqual(specs.map((s) => s.unitKey), ['reading[0]', 'reading[2]'])
  assert.deepEqual(specs.map((s) => s.varName), ['reading[0]', 'reading[2]'])
})

test('an unnamed mapped slot falls back to column [index]', () => {
  const specs = deriveSeriesSpecs({
    metric: 'reading', columnLabels: { reading: 'Pressure' },
    arraySlots: { reading: [{ index: 0 }, { index: 1 }] },
  })
  // [{index:0}] alone is the default, but two slots are a real mapping.
  assert.deepEqual(specs.map((s) => s.label), ['Pressure [0]', 'Pressure [1]'])
})

test('slots cross with series values and keep the filter value in the label', () => {
  const specs = deriveSeriesSpecs({
    metric: 'reading', filterCol: 'tag', filters: ['A', 'B'],
    arraySlots: { reading: [{ index: 0, name: 'Now' }, { index: 1, name: 'Max' }] },
  })
  assert.deepEqual(specs.map((s) => s.label), ['Now · A', 'Now · B', 'Max · A', 'Max · B'])
  assert.equal(new Set(keysOf(specs)).size, 4)
})

test('a lone unnamed slot 0 is the legacy series, not a mapping', () => {
  const [spec] = deriveSeriesSpecs({ metric: 'reading', arraySlots: { reading: [{ index: 0 }] } })
  assert.equal(spec.key, '["reading",null]')
  assert.equal(spec.slot, null)
  assert.equal(spec.varName, 'reading')
})

test('text columns are flagged', () => {
  const specs = deriveSeriesSpecs({ metric: 'n', valueCols: ['status'], textCols: ['status'] })
  assert.deepEqual(specs.map((s) => s.isText), [false, true])
})

test('cleanSlots drops bad indexes, dedupes and sorts', () => {
  assert.deepEqual(
    cleanSlots([{ index: '3', name: ' c ' }, { index: -1 }, { index: 1.5 }, { index: 3, name: 'z' }, { index: 0 }, null]),
    [{ index: 0 }, { index: 3, name: 'z' }],
  )
  assert.deepEqual(slotsOf({}, 'x'), [{ index: 0 }])
  assert.equal(isDefaultSlots([{ index: 0 }]), true)
  assert.equal(isDefaultSlots([{ index: 0, name: 'm' }]), false)
})

test('pruneArraySlots keeps only bound, non-default entries', () => {
  const out = pruneArraySlots({
    a: [{ index: 0 }],
    b: [{ index: 1, name: 'x' }],
    gone: [{ index: 2, name: 'y' }],
  }, ['a', 'b'])
  assert.deepEqual(out, { b: [{ index: 1, name: 'x' }] })
})

test('pickSlot reads an array slot and passes a scalar through for slot 0 only', () => {
  assert.equal(pickSlot([5, 6, null], 1), 6)
  assert.equal(pickSlot([5, 6, null], 2), null)
  assert.equal(pickSlot([5, 6], null), 5)
  assert.equal(pickSlot(7, 0), 7)
  assert.equal(pickSlot(7, null), 7)
  assert.equal(pickSlot(7, 1), null)
  assert.equal(pickSlot('RUN', null), 'RUN')
})

test('groupBySource asks the server once per column and series value', () => {
  const specs = deriveSeriesSpecs({
    metric: 'reading', valueCols: ['rate'], filterCol: 'tag', filters: ['A', 'B'],
    arraySlots: { reading: [{ index: 0 }, { index: 1 }, { index: 2 }] },
  })
  assert.equal(specs.length, 8)
  const groups = groupBySource(specs)
  assert.equal(groups.length, 4)
  assert.equal(groups[0].members.length, 3)
})

test('text needs a stat or table; charts need at least one number', () => {
  const textOnly = deriveSeriesSpecs({ metric: 's', textCols: ['s'] })
  const mixed = deriveSeriesSpecs({ metric: 'n', valueCols: ['s'], textCols: ['s'] })
  assert.equal(hasPlottableSeries('stat', textOnly), true)
  assert.equal(hasPlottableSeries('table', textOnly), true)
  assert.equal(hasPlottableSeries('timeseries', textOnly), false)
  assert.equal(hasPlottableSeries('gauge', textOnly), false)
  assert.equal(hasPlottableSeries('timeseries', mixed), true)
})
