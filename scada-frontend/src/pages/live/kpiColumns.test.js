import test from 'node:test'
import assert from 'node:assert/strict'
import { columnChoices, whyNotCounted, picksArray, filterChoices } from './kpiColumns.js'

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

test('every column of the table is listed once, with its type badge', () => {
  const all = columnChoices(LOGS)
  assert.deepEqual(all.map((c) => c.name).sort(), Object.keys(LOGS.column_types).sort())
  assert.equal(all.find((c) => c.name === 'defect_array').badge, 'int4[]')
})

test('numbers, arrays and flags can be counted; text, time and the rest cannot', () => {
  const by = Object.fromEntries(columnChoices({ ...LOGS, bool_columns: ['alarm_active'] }).map((c) => [c.name, c]))
  for (const n of ['camera_id', 'defect_array', 'alarm_active']) assert.equal(by[n]?.countable, true, n)
  for (const n of ['code', 'created_at', 'payload', 'id']) assert.equal(by[n].countable, false, n)
  assert.equal(by.defect_array.group, 'Arrays')
  assert.equal(by.payload.group, 'Other')
})

test('an uncountable column says why', () => {
  const by = Object.fromEntries(columnChoices(LOGS).map((c) => [c.name, c]))
  assert.equal(whyNotCounted(by.defect_array), '')
  assert.match(whyNotCounted(by.code), /pick rows/)
  assert.match(whyNotCounted(by.created_at), /clock/)
  assert.match(whyNotCounted(by.payload), /Not a number/)
})

test('the array rule matters only when an array is picked', () => {
  const choices = columnChoices(LOGS)
  assert.equal(picksArray(choices, ['camera_id']), false)
  assert.equal(picksArray(choices, ['camera_id', 'defect_array']), true)
  assert.equal(picksArray(choices, null), false)
})

test('rows are picked by text, flag or id columns — never a clock', () => {
  assert.deepEqual(filterChoices(LOGS), ['id', 'code', 'name', 'location'])
  assert.deepEqual(filterChoices(null), [])
})

test('a table that describes nothing lists nothing', () => {
  assert.deepEqual(columnChoices(undefined), [])
})
