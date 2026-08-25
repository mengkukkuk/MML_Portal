import test from 'node:test'
import assert from 'node:assert/strict'
import { fitToContents, snapValue, zoomAtPoint } from './editorViewport.js'

test('zoom keeps the pointer-centred world coordinate stationary', () => {
  const view = { x: 0, y: 0, w: 1600, h: 900 }
  const next = zoomAtPoint(view, 800, 450, 2)
  assert.deepEqual(next, { x: 400, y: 225, w: 800, h: 450 })
})

test('zoom is clamped to 25–400 percent', () => {
  let view = { x: 0, y: 0, w: 1600, h: 900 }
  for (let i = 0; i < 20; i += 1) view = zoomAtPoint(view, 800, 450, 2)
  assert.equal(view.w, 400)
  for (let i = 0; i < 40; i += 1) view = zoomAtPoint(view, 800, 450, 0.5)
  assert.equal(view.w, 6400)
})

test('zoom limits are relative to an imported layout width', () => {
  const view = { x: 0, y: 0, w: 1000, h: 600 }
  assert.equal(zoomAtPoint(view, 500, 300, 100, 1000).w, 250)
  assert.equal(zoomAtPoint(view, 500, 300, 0.001, 1000).w, 4000)
})

test('fit-to-content adds padding and preserves canvas aspect ratio', () => {
  const next = fitToContents([{ x: 100, y: 100, w: 200, h: 100 }], 16 / 9, 40)
  assert.equal(Math.round(next.w / next.h * 1000), 1778)
  assert.ok(next.x <= 60 && next.y <= 60)
})

test('snap is an 8-unit toggle', () => {
  assert.equal(snapValue(13, true), 16)
  assert.equal(snapValue(13, false), 13)
})
