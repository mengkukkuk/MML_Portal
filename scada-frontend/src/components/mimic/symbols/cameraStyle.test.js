import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_STYLES, DEFAULT_CAMERA_STYLE, DEFAULT_PLATE_PLACEMENT, PLATE_PLACEMENTS,
  cameraStyle, platePlacement,
} from './cameraStyle.js'

test('a missing or unknown style is the smart camera, so older drawings are unchanged', () => {
  assert.equal(cameraStyle(undefined), 'smart')
  assert.equal(cameraStyle(null), 'smart')
  assert.equal(cameraStyle({}), 'smart')
  assert.equal(cameraStyle({ cameraStyle: 'dome' }), 'smart')
  assert.equal(cameraStyle({ cameraStyle: 'classic' }), 'classic')
})

test('a missing or unknown plate placement follows the camera', () => {
  assert.equal(platePlacement(undefined), 'follow')
  assert.equal(platePlacement({}), 'follow')
  assert.equal(platePlacement({ platePlacement: 'sideways' }), 'follow')
  assert.equal(platePlacement({ platePlacement: 'upright' }), 'upright')
})

test('every offered style and placement resolves to itself', () => {
  for (const { id } of CAMERA_STYLES) assert.equal(cameraStyle({ cameraStyle: id }), id)
  for (const { id } of PLATE_PLACEMENTS) assert.equal(platePlacement({ platePlacement: id }), id)
})

test('the default is among the choices, so the select can always show what is drawn', () => {
  assert.ok(CAMERA_STYLES.some((c) => c.id === DEFAULT_CAMERA_STYLE))
  assert.ok(PLATE_PLACEMENTS.some((p) => p.id === DEFAULT_PLATE_PLACEMENT))
})

test('each choice is distinct and has the text the inspector prints', () => {
  for (const list of [CAMERA_STYLES, PLATE_PLACEMENTS]) {
    assert.equal(new Set(list.map((c) => c.id)).size, list.length)
    for (const c of list) {
      assert.ok(c.label.trim().length > 0, `${c.id} has a label`)
      assert.ok(c.hint.trim().length > 0, `${c.id} has a hint`)
    }
  }
})
