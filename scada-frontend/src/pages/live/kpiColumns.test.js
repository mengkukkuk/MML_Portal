import test from 'node:test'
import assert from 'node:assert/strict'
import { columnChoices, usableAs, whyNotUsable, picksArray, filterChoices, numericColumns } from './kpiColumns.js'

// camera_defect_logs, as /schema/columns describes it
const LOGS = {
  value_columns: ['camera_id', 'batch_id'],
  array_value_columns: ['defect_array'],
  bool_columns: [],
  ts_columns: ['created_at', 'updated_at'],
  text_columns: ['code', 'name', 'location'],
  filter_columns: ['id', 'code', 'name', 'location', 'created_at', 'updated_at'],
  column_types: {
    id: 'int8', camera_id: 'int4', code: 'text', name: 'text', location: 'text', batch_id: 'int4',
    defect_array: 'int4[]', created_at: 'timestamptz', updated_at: 'timestamptz', payload: 'jsonb',
  },
}
const byName = (cols) => Object.fromEntries(columnChoices(cols).map((c) => [c.name, c]))

test('every column of the table is listed once, with its type badge', () => {
  const all = columnChoices(LOGS)
  assert.deepEqual(all.map((c) => c.name).sort(), Object.keys(LOGS.column_types).sort())
  assert.equal(all.find((c) => c.name === 'defect_array').badge, 'int4[]')
})

test('machine blocks read numbers and numeric arrays; a defect tally also reads flags', () => {
  const by = byName({ ...LOGS, bool_columns: ['alarm_active'] })
  for (const n of ['camera_id', 'defect_array']) {
    assert.equal(usableAs(by[n], 'number'), true, n)
    assert.equal(usableAs(by[n], 'count'), true, n)
  }
  assert.equal(usableAs(by.alarm_active, 'number'), false)
  assert.equal(usableAs(by.alarm_active, 'count'), true)
  for (const n of ['code', 'created_at', 'payload', 'id']) {
    assert.equal(usableAs(by[n], 'number'), false, n)
    assert.equal(usableAs(by[n], 'count'), false, n)
  }
  assert.equal(by.defect_array.group, 'Arrays')
  assert.equal(by.payload.group, 'Other')
})

test('an unusable column says why', () => {
  const by = byName(LOGS)
  assert.match(whyNotUsable(by.code), /name machines or pick rows/)
  assert.match(whyNotUsable(by.created_at), /clock/)
  assert.match(whyNotUsable(by.payload), /Not a number/)
})

test('the array rule matters only when an array is picked', () => {
  const choices = columnChoices(LOGS)
  assert.equal(picksArray(choices, ['camera_id']), false)
  assert.equal(picksArray(choices, ['camera_id', 'defect_array']), true)
  assert.equal(picksArray(choices, null), false)
})

test('machines and rows are named by text, flag or id columns — never a clock', () => {
  assert.deepEqual(filterChoices(LOGS), ['id', 'code', 'name', 'location'])
  assert.deepEqual(filterChoices(null), [])
})

test('sensors are chosen among the numeric columns', () => {
  assert.deepEqual(numericColumns(LOGS), ['camera_id', 'batch_id', 'defect_array'])
  assert.deepEqual(numericColumns(undefined), [])
})

test('a table that describes nothing lists nothing', () => {
  assert.deepEqual(columnChoices(undefined), [])
})
