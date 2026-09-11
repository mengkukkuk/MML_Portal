import test from 'node:test'
import assert from 'node:assert/strict'
import { groupByFamily } from './nameFamilies.js'

test('groups names under a named base column', () => {
  const names = ['CAM001-13', 'CAM002-13', 'Pressure1', 'Tanklevel',
    'CAM001-13-count_1', 'CAM001-13-count_2', 'CAM001-13-defect_1',
    'CAM002-13-count_1', 'CAM002-13-defect_1']
  const groups = groupByFamily(names)
  assert.deepEqual(groups.map((g) => g.key), ['CAM001-13', 'CAM002-13', ''])
  assert.deepEqual(groups[0].names, ['CAM001-13', 'CAM001-13-count_1', 'CAM001-13-count_2', 'CAM001-13-defect_1'])
  assert.deepEqual(groups.flatMap((g) => g.names).sort(), [...names].sort())
})

test('detects repeated suffix families without requiring a base column', () => {
  const groups = groupByFamily(['Pump-A-count_1', 'Pump-A-defect_1', 'Pump-B-count_1'])
  assert.deepEqual(groups.map((g) => g.key), ['Pump-A', ''])
  assert.deepEqual(groups[0].names, ['Pump-A-count_1', 'Pump-A-defect_1'])
})

test('a lone hyphenated name does not group by itself', () => {
  const groups = groupByFamily(['Pump-A-count_1', 'Pump-B-count_1'])
  assert.deepEqual(groups.map((g) => g.key), [''])
  assert.deepEqual(groups[0].names, ['Pump-A-count_1', 'Pump-B-count_1'])
})

test('keeps distinct numbered devices and delimiter boundaries intact', () => {
  const groups = groupByFamily(['CAM001-13', 'CAM001-14', 'CAM001-13-count_1',
    'CAM001-14-count_1', 'CAM001-130-count_1', 'Pressure1', 'Pressure10'])
  assert.deepEqual(groups.map((g) => g.key), ['CAM001-13', 'CAM001-14', ''])
  assert.ok(groups.find((g) => g.key === '').names.includes('CAM001-130-count_1'))
})

test('empty and unrelated names stay flat', () => {
  assert.deepEqual(groupByFamily(), [])
  const groups = groupByFamily(['Pressure1', 'Pressure2', 'Tanklevel', 'Temperature1'])
  assert.deepEqual(groups.map((g) => g.key), [''])
  assert.deepEqual(groups[0].names, ['Pressure1', 'Pressure2', 'Tanklevel', 'Temperature1'])
})

test('prefers the closest existing base for nested names', () => {
  const groups = groupByFamily(['Pump', 'Pump-A', 'Pump-A-count_1'])
  const pumpA = groups.find((g) => g.key === 'Pump-A')
  assert.deepEqual(pumpA.names, ['Pump-A', 'Pump-A-count_1'])
})
