import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDefectLabelsByCode, resolveReadingLabel, resolveTagLabel } from './defectLabels.js'

const cameras = [
  { code: 'CAM001-13', defect_labels: ['Roll NG', 'Filter NG', null, '', 'defect_5'] },
  { code: 'CAM002-13', defect_labels: [] },
]

test('buildDefectLabelsByCode maps code to its defect_labels array', () => {
  const map = buildDefectLabelsByCode(cameras)
  assert.deepEqual(map.get('CAM001-13'), ['Roll NG', 'Filter NG', null, '', 'defect_5'])
  assert.deepEqual(map.get('CAM002-13'), [])
  assert.equal(map.get('CAM003-13'), undefined)
})

test('buildDefectLabelsByCode tolerates a missing list', () => {
  assert.deepEqual([...buildDefectLabelsByCode().entries()], [])
})

test('resolveReadingLabel swaps a configured slot, falls back otherwise', () => {
  const labelsByCode = buildDefectLabelsByCode(cameras)
  assert.equal(resolveReadingLabel('CAM001-13', 'defect_1', labelsByCode), 'Roll NG')
  assert.equal(resolveReadingLabel('CAM001-13', 'defect_2', labelsByCode), 'Filter NG')
  // null, empty string, and "no camera for this slot" all fall back to the raw suffix.
  assert.equal(resolveReadingLabel('CAM001-13', 'defect_3', labelsByCode), 'defect_3')
  assert.equal(resolveReadingLabel('CAM001-13', 'defect_4', labelsByCode), 'defect_4')
  assert.equal(resolveReadingLabel('CAM001-13', 'defect_9', labelsByCode), 'defect_9')
  assert.equal(resolveReadingLabel('CAM002-13', 'defect_1', labelsByCode), 'defect_1')
  assert.equal(resolveReadingLabel('CAM999-13', 'defect_1', labelsByCode), 'defect_1')
  // Non-defect suffixes are never touched.
  assert.equal(resolveReadingLabel('CAM001-13', 'count_1', labelsByCode), 'count_1')
})

test('resolveTagLabel handles a bare defect_n tag paired with a location', () => {
  const labelsByCode = buildDefectLabelsByCode(cameras)
  assert.equal(resolveTagLabel('defect_1', 'CAM001-13', labelsByCode), 'Roll NG')
  assert.equal(resolveTagLabel('defect_3', 'CAM001-13', labelsByCode), 'defect_3')
  assert.equal(resolveTagLabel('defect_1', 'Unknown', labelsByCode), 'defect_1')
})

test('resolveTagLabel handles a compound CODE-defect_n tag, keeping the prefix', () => {
  const labelsByCode = buildDefectLabelsByCode(cameras)
  assert.equal(resolveTagLabel('CAM001-13-defect_1', null, labelsByCode), 'CAM001-13-Roll NG')
  assert.equal(resolveTagLabel('CAM001-13-defect_9', null, labelsByCode), 'CAM001-13-defect_9')
})

test('resolveTagLabel is a no-op with no map or no tag name', () => {
  assert.equal(resolveTagLabel('defect_1', 'CAM001-13', new Map()), 'defect_1')
  assert.equal(resolveTagLabel('', 'CAM001-13', buildDefectLabelsByCode(cameras)), '')
  assert.equal(resolveTagLabel(null, 'CAM001-13', buildDefectLabelsByCode(cameras)), null)
})
