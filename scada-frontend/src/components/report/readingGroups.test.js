import test from 'node:test'
import assert from 'node:assert/strict'
import { groupReadings, readingTitle } from './readingGroups.js'

test('groups the pictured camera columns without losing or duplicating readings', () => {
  const names = ['CAM001-13', 'CAM002-13', 'Pressure1', 'Tanklevel',
    'CAM001-13-count_1', 'CAM001-13-count_2', 'CAM001-13-defect_1',
    'CAM002-13-count_1', 'CAM002-13-defect_1']
  const groups = groupReadings([...names, names[0]])
  assert.deepEqual(groups.map((g) => g.key), ['CAM001-13', 'CAM002-13', ''])
  assert.deepEqual(groups[0].options.map((o) => o.label), ['Base reading', 'count_1', 'count_2', 'defect_1'])
  assert.deepEqual(groups.flatMap((g) => g.options.map((o) => o.value)).sort(), [...names].sort())
  assert.equal(readingTitle(groups, 'CAM001-13-count_1'), 'CAM001-13 · count_1')
  assert.equal(readingTitle(groups, 'CAM001-13'), 'CAM001-13')
  assert.equal(readingTitle(groups, 'Pressure1'), 'Pressure1')
})

test('detects repeated suffix families without requiring a base column', () => {
  const groups = groupReadings(['Pump-A-count_1', 'Pump-A-defect_1', 'Pump-B-count_1'])
  assert.deepEqual(groups.map((g) => g.key), ['Pump-A', ''])
  assert.equal(readingTitle(groups, 'Pump-A-defect_1'), 'Pump-A · defect_1')
  assert.equal(readingTitle(groups, 'Pump-B-count_1'), 'Pump-B-count_1')
})

test('keeps distinct numbered devices and delimiter boundaries intact', () => {
  const groups = groupReadings(['CAM001-13', 'CAM001-14', 'CAM001-13-count_1',
    'CAM001-14-count_1', 'CAM001-130-count_1', 'Pressure1', 'Pressure10'])
  assert.deepEqual(groups.map((g) => g.key), ['CAM001-13', 'CAM001-14', ''])
  assert.equal(readingTitle(groups, 'CAM001-130-count_1'), 'CAM001-130-count_1')
})

test('empty and unrelated schemas stay flat and stale readings retain their full name', () => {
  assert.deepEqual(groupReadings(), [])
  const groups = groupReadings(['Pressure1', 'Pressure2', 'Tanklevel', 'Temperature1'])
  assert.deepEqual(groups.map((g) => g.key), [''])
  assert.equal(readingTitle(groups, 'CAM001-13-count_1'), 'CAM001-13-count_1')
})

test('prefers the closest existing base for nested names', () => {
  const groups = groupReadings(['Pump', 'Pump-A', 'Pump-A-count_1'])
  assert.equal(readingTitle(groups, 'Pump-A-count_1'), 'Pump-A · count_1')
  assert.equal(groups.find((g) => g.key === 'Pump-A').options[0].value, 'Pump-A')
})
