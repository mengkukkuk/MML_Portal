import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFamilies, worstSeverity, compareBySeverityThenName } from './alarmFamilies.js'

const item = (name, extra = {}) => ({ name, severity: 'info', count: 1, ...extra })

test('collapses a tag-name family into one entry', () => {
  const families = buildFamilies({
    items: [
      item('CAM001-13-count_1'),
      item('CAM001-13-defect_1'),
      item('CAM002-13-count_1'),
      item('CAM002-13-defect_1'),
    ],
  })
  assert.deepEqual(families.map((f) => f.key), ['CAM001-13', 'CAM002-13'])
  assert.ok(families.every((f) => f.isGroup))
  assert.deepEqual(families[0].members.map((m) => m.name), [
    'CAM001-13-count_1',
    'CAM001-13-defect_1',
  ])
})

test('a family survives dropping to one live member when the superset knows it', () => {
  const knownNames = [
    'CAM001-13-count_1', 'CAM001-13-count_2', 'CAM001-13-defect_1',
  ]
  const families = buildFamilies({ items: [item('CAM001-13-count_1')], knownNames })
  assert.deepEqual(families.map((f) => f.key), ['CAM001-13'])
  assert.equal(families[0].isGroup, true)
  assert.equal(families[0].total, 1)
})

test('without the superset a lone member would not group at all', () => {
  // Pins the exact regression the knownNames argument exists to prevent: this
  // is what the Alarms grid did when fed only its live rows.
  const families = buildFamilies({ items: [item('CAM001-13-count_1')] })
  assert.deepEqual(families.map((f) => f.key), ['CAM001-13-count_1'])
  assert.equal(families[0].isGroup, false)
})

test('names with no family become their own single entries, not one shared bucket', () => {
  const families = buildFamilies({
    items: [item('SIM-Capper-02'), item('SIM-Filler-01'), item('Tanklevel')],
  })
  assert.deepEqual(families.map((f) => f.key), ['SIM-Capper-02', 'SIM-Filler-01', 'Tanklevel'])
  assert.ok(families.every((f) => !f.isGroup && f.members.length === 1))
})

test('sorts by worst severity first, then name with numeric collation', () => {
  const families = buildFamilies({
    items: [
      item('CAM010-13-count_1'),
      item('CAM010-13-defect_1'),
      item('CAM002-13-count_1'),
      item('CAM002-13-defect_1', { severity: 'critical' }),
      item('CAM003-13-count_1', { severity: 'warning' }),
      item('CAM003-13-defect_1'),
    ],
  })
  assert.deepEqual(families.map((f) => f.key), ['CAM002-13', 'CAM003-13', 'CAM010-13'])
  assert.deepEqual(families.map((f) => f.severity), ['critical', 'warning', 'info'])
})

test('members inside a family follow the same ordering', () => {
  const families = buildFamilies({
    items: [
      item('CAM001-13-count_1'),
      item('CAM001-13-count_2', { severity: 'critical' }),
      item('CAM001-13-defect_1', { severity: 'warning' }),
    ],
  })
  assert.deepEqual(families[0].members.map((m) => m.name), [
    'CAM001-13-count_2',
    'CAM001-13-defect_1',
    'CAM001-13-count_1',
  ])
})

test('aggregates counts, unacked and latest timestamp across members', () => {
  const families = buildFamilies({
    items: [
      item('CAM001-13-count_1', { count: 4, unacked: 1, latest: '2026-09-12T09:00:00Z' }),
      item('CAM001-13-defect_1', { count: 8, unacked: 2, latest: '2026-09-12T11:00:00Z' }),
      item('CAM001-13-defect_1', { count: 1, unacked: 0, latest: '2026-09-12T10:00:00Z' }),
    ],
  })
  const [fam] = families
  assert.equal(fam.total, 13)
  assert.equal(fam.unacked, 3)
  assert.equal(fam.latest, '2026-09-12T11:00:00Z')
  // Three rows but two distinct tags — the row meta says "2 tags · 13 alarms".
  assert.equal(fam.tagCount, 2)
})

test('grouped:false bypasses grouping for the tag-filter case', () => {
  const items = [item('CAM001-13-count_1'), item('CAM001-13-defect_1')]
  const families = buildFamilies({ items, grouped: false })
  assert.deepEqual(families.map((f) => f.key), ['CAM001-13-count_1', 'CAM001-13-defect_1'])
  assert.ok(families.every((f) => !f.isGroup))
})

test('a named base column joins its own family', () => {
  const families = buildFamilies({
    items: [item('CAM001-13'), item('CAM001-13-count_1'), item('CAM001-13-defect_1')],
  })
  assert.deepEqual(families.map((f) => f.key), ['CAM001-13'])
  assert.equal(families[0].members.length, 3)
})

test('no items yields no families', () => {
  assert.deepEqual(buildFamilies(), [])
  assert.deepEqual(buildFamilies({ items: [], knownNames: ['CAM001-13-count_1'] }), [])
})

test('worstSeverity picks the highest rank and defaults to info', () => {
  assert.equal(worstSeverity(['info', 'critical', 'warning']), 'critical')
  assert.equal(worstSeverity(['info', 'warning']), 'warning')
  assert.equal(worstSeverity([]), 'info')
  assert.equal(worstSeverity([undefined, null]), 'info')
})

test('comparator is stable for identical severity and name', () => {
  const a = { name: 'CAM001-13', severity: 'info' }
  const b = { name: 'CAM001-13', severity: 'info' }
  assert.equal(compareBySeverityThenName(a, b), 0)
})
