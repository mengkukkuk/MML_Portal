import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SCALE, actualView, clampScale, fitScale, fitView, isFitted, panBy, pinchMetrics, zoomAt,
} from './imageViewport.js'

const box = { w: 800, h: 600 }
const big = { w: 2000, h: 1500 }

test('a frame larger than the stage fits whole, centred', () => {
  assert.equal(fitScale(big, box), 0.4)
  assert.deepEqual(fitView(big, box), { scale: 0.4, x: 0, y: 0 })
  const wide = { w: 2000, h: 500 }
  const v = fitView(wide, box)
  assert.equal(v.scale, 0.4)
  assert.equal(v.y, 200)
})

test('a small frame is never enlarged to fit', () => {
  const small = { w: 400, h: 300 }
  assert.equal(fitScale(small, box), 1)
  assert.deepEqual(fitView(small, box), { scale: 1, x: 200, y: 150 })
})

test('bad sizes fall back to 100 percent instead of NaN', () => {
  assert.equal(fitScale(null, box), 1)
  assert.equal(fitScale(big, { w: 0, h: 0 }), 1)
})

test('scale is clamped between fit and the maximum', () => {
  assert.equal(clampScale(0.01, big, box), 0.4)
  assert.equal(clampScale(100, big, box), MAX_SCALE)
})

test('zoom keeps the point under the cursor stationary', () => {
  const start = fitView(big, box)
  const next = zoomAt(start, big, box, 1, 400, 300)
  // image point under the cursor before: (400-0)/0.4 = 1000, (300-0)/0.4 = 750
  assert.equal(next.scale, 1)
  assert.equal(next.x + 1000 * next.scale, 400)
  assert.equal(next.y + 750 * next.scale, 300)
})

test('panning cannot pull the image edge into the stage', () => {
  const zoomed = actualView(fitView(big, box), big, box)
  const left = panBy(zoomed, big, box, 99999, 99999)
  assert.deepEqual([left.x, left.y], [0, 0])
  const right = panBy(zoomed, big, box, -99999, -99999)
  assert.deepEqual([right.x, right.y], [box.w - big.w, box.h - big.h])
})

test('fitted frames do not pan', () => {
  const fit = fitView(big, box)
  assert.deepEqual(panBy(fit, big, box, 50, 50), fit)
})

test('zooming back out to fit re-centres and reports fitted', () => {
  let v = actualView(fitView(big, box), big, box)
  v = zoomAt(v, big, box, 0.001, 123, 45)
  assert.equal(isFitted(v, big, box), true)
  assert.deepEqual(v, fitView(big, box))
})

test('pinch metrics give distance and midpoint', () => {
  assert.deepEqual(pinchMetrics({ x: 0, y: 0 }, { x: 30, y: 40 }), { dist: 50, cx: 15, cy: 20 })
})
