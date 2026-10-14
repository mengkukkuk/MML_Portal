import test from 'node:test'
import assert from 'node:assert/strict'
import {
  boxPoint, gripCursor, positionBounds, resizeBox,
} from './nodeResize.js'

const SHEET = { w: 1600, h: 900 }
const GRID = 8
const H = {
  nw: { fx: 0, fy: 0, ex: 'l', ey: 't' },
  e: { fx: 1, fy: 0.5, ex: 'r', ey: null },
  se: { fx: 1, fy: 1, ex: 'r', ey: 'b' },
  w: { fx: 0, fy: 0.5, ex: 'l', ey: null },
  s: { fx: 0.5, fy: 1, ex: null, ey: 'b' },
}
const drag = (handle, rot = 0, box = { x: 400, y: 400, w: 160, h: 80 }) => ({
  x0: box.x, y0: box.y, w0: box.w, h0: box.h, rot, handle,
})
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`)

test('upright: matches the plain edge-drag behaviour', () => {
  assert.deepEqual(resizeBox(drag(H.e), 40, 0, false, true, SHEET, GRID), { x: 400, y: 400, w: 200, h: 80 })
  assert.deepEqual(resizeBox(drag(H.w), -37, 0, false, true, SHEET, GRID), { x: 360, y: 400, w: 200, h: 80 })
  assert.deepEqual(resizeBox(drag(H.se), 40, 20, false, false, SHEET, GRID), { x: 400, y: 400, w: 200, h: 100 })
})

for (const rot of [0, 45, 90, 135, 180, 270, 330]) {
  test(`rot ${rot}: the opposite grip stays pinned on the sheet`, () => {
    for (const [id, opp] of [['se', [0, 0]], ['nw', [1, 1]], ['e', [0, 0.5]], ['s', [0.5, 0]]]) {
      const d = drag(H[id], rot)
      const before = boxPoint({ x: d.x0, y: d.y0, w: d.w0, h: d.h0, rot }, ...opp)
      const b = resizeBox(d, 33, -21, false, false, SHEET, GRID)
      const after = boxPoint({ ...b, rot }, ...opp)
      near(after.x, before.x, `${id} x`)
      near(after.y, before.y, `${id} y`)
    }
  })
}

test('rot 90: dragging the grip that sits at the bottom on screen grows the box downward', () => {
  // At 90° the "e" grip (right edge of the box) faces down the sheet.
  const d = drag(H.e, 90)
  const grip0 = boxPoint({ x: d.x0, y: d.y0, w: d.w0, h: d.h0, rot: 90 }, 1, 0.5)
  const b = resizeBox(d, 0, 40, false, false, SHEET, GRID)
  assert.equal(b.w, 200)
  assert.equal(b.h, 80)
  const grip1 = boxPoint({ ...b, rot: 90 }, 1, 0.5)
  near(grip1.y - grip0.y, 40, 'moved with pointer')
  near(grip1.x, grip0.x, 'no sideways drift')
  // Sideways travel is ignored by an edge grip.
  assert.equal(resizeBox(d, 50, 0, false, false, SHEET, GRID).w, 160)
})

test('quarter turns snap the held grip to a sheet grid line', () => {
  const d = drag(H.se, 180)
  const b = resizeBox(d, -13, -29, false, true, SHEET, GRID)
  const grip = boxPoint({ ...b, rot: 180 }, 1, 1)
  near(grip.x % GRID, 0, 'x on grid')
  near(grip.y % GRID, 0, 'y on grid')
})

test('a tilted box snaps its size to grid steps instead', () => {
  const b = resizeBox(drag(H.se, 30), 23, 11, false, true, SHEET, GRID)
  assert.equal(b.w % GRID, 0)
  assert.equal(b.h % GRID, 0)
})

test('never smaller than the minimum and never off the sheet', () => {
  const tiny = resizeBox(drag(H.se, 90), -500, -500, false, false, SHEET, GRID)
  assert.ok(tiny.w >= 24 && tiny.h >= 24)
  const huge = resizeBox(drag(H.se, 45), 3000, 3000, false, false, SHEET, GRID)
  const b = positionBounds({ ...huge, rot: 45 }, SHEET)
  assert.ok(huge.x >= b.minX - 0.02 && huge.x <= b.maxX + 0.02)
  assert.ok(huge.y >= b.minY - 0.02 && huge.y <= b.maxY + 0.02)
})

test('shift keeps the proportions at any angle', () => {
  const b = resizeBox(drag(H.se, 135), 60, 0, true, false, SHEET, GRID)
  assert.ok(Math.abs(b.w / b.h - 2) < 0.02, `aspect ${b.w}/${b.h}`)
})

test('positionBounds: upright is [0, sheet - size]; turned uses the footprint', () => {
  assert.deepEqual(positionBounds({ w: 160, h: 80, rot: 0 }, SHEET), {
    minX: 0, maxX: 1440, minY: 0, maxY: 820,
  })
  const r = positionBounds({ w: 160, h: 80, rot: 90 }, SHEET)
  near(r.minX, -40, 'minX')
  near(r.minY, 40, 'minY')
})

test('grip cursors follow the rotation', () => {
  assert.equal(gripCursor(H.e, 0), 'ew-resize')
  assert.equal(gripCursor(H.e, 90), 'ns-resize')
  assert.equal(gripCursor(H.se, 0), 'nwse-resize')
  assert.equal(gripCursor(H.se, 90), 'nesw-resize')
  assert.equal(gripCursor(H.e, 45), 'nwse-resize')
})
