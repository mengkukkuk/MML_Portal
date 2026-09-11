import assert from 'node:assert/strict'
import { test } from 'node:test'

import { badgeFor, filterGroups, groupColumns, pickableColumns } from './columnKinds.js'

/**
 * The picker's job is to answer "what kind of column is this" *before* it is
 * bound, so the cases that matter are the ones where the answer is missing or
 * partial: an older server, a table mid-fetch, a kind this table has none of.
 */

const COLS = {
  value_columns: ['temperature', 'count'],
  bool_columns: ['enabled'],
  text_columns: ['code'],
  column_types: {
    temperature: 'float8',
    count: 'int4',
    enabled: 'bool',
    code: 'text',
  },
}

test('groups appear in the order asked for, not the order the server sent', () => {
  const groups = groupColumns(COLS, ['bool_columns', 'value_columns'])
  assert.deepEqual(groups.map((g) => g.key), ['bool_columns', 'value_columns'])
})

test('each option carries its type badge', () => {
  const [numeric] = groupColumns(COLS, ['value_columns'])
  assert.deepEqual(numeric.options, [
    { name: 'temperature', badge: 'float8' },
    { name: 'count', badge: 'int4' },
  ])
})

test('an empty kind is dropped, a kind of one is still labelled', () => {
  // Dropped: a heading over nothing reads as a failed fetch. Kept-and-labelled:
  // two editors showing the same table have to read alike, and a lone
  // unlabelled option is the ambiguity this exists to remove.
  const groups = groupColumns(COLS, ['value_columns', 'array_value_columns', 'bool_columns'])
  assert.deepEqual(groups.map((g) => g.key), ['value_columns', 'bool_columns'])
  assert.equal(groups[1].label, 'Boolean — on/off')
})

test('a server with no column_types yields blank badges, not undefined', () => {
  const older = { value_columns: ['temperature'] }
  assert.equal(badgeFor(older, 'temperature'), '')
  assert.deepEqual(groupColumns(older, ['value_columns'])[0].options, [
    { name: 'temperature', badge: '' },
  ])
})

test('a null envelope renders nothing rather than throwing', () => {
  // What a picker holds while its columns request is still in flight.
  assert.deepEqual(groupColumns(null, ['value_columns']), [])
  assert.deepEqual(pickableColumns(null, ['value_columns']), [])
  assert.equal(badgeFor(null, 'temperature'), '')
})

test('pickableColumns flattens exactly what groupColumns would draw', () => {
  const kinds = ['value_columns', 'bool_columns']
  const drawn = groupColumns(COLS, kinds).flatMap((g) => g.options.map((o) => o.name))
  assert.deepEqual(pickableColumns(COLS, kinds), drawn)
})

test('search matches the column name only, never the badge', () => {
  // Typing "int" to find `print_head` must not return every integer column.
  const cols = {
    value_columns: ['print_head', 'count'],
    column_types: { print_head: 'float8', count: 'int4' },
  }
  const groups = groupColumns(cols, ['value_columns'])
  assert.deepEqual(filterGroups(groups, 'int')[0].options, [
    { name: 'print_head', badge: 'float8' },
  ])
})

test('search is case-insensitive and drops groups it empties', () => {
  const groups = groupColumns(COLS, ['value_columns', 'bool_columns'])
  assert.deepEqual(filterGroups(groups, 'TEMP').map((g) => g.key), ['value_columns'])
})

test('a blank query returns the groups untouched', () => {
  const groups = groupColumns(COLS, ['value_columns', 'bool_columns'])
  assert.equal(filterGroups(groups, '   '), groups)
})

test('search also matches a caller-supplied display label, not just the raw name', () => {
  const cols = { value_columns: ['CAM001-13-defect_1', 'CAM001-13-count_1'] }
  const groups = groupColumns(cols, ['value_columns'])
  const labelFor = (name) => (name === 'CAM001-13-defect_1' ? 'CAM001-13-Roll NG' : name)
  assert.deepEqual(filterGroups(groups, 'roll', labelFor)[0].options, [
    { name: 'CAM001-13-defect_1', badge: '' },
  ])
  // The raw name still matches too, independently of the label.
  assert.deepEqual(filterGroups(groups, 'count_1', labelFor)[0].options, [
    { name: 'CAM001-13-count_1', badge: '' },
  ])
})
