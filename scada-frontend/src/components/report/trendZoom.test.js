import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZOOM_STEP, buildDataZoom, canZoomIn, canZoomOut, frameAt, minSpan, pinchGeometry, resolveView, selectionToView,
  viewFromRange, zoomBy, zoomPercent,
} from './trendZoom.js'

const HOUR = 3_600_000
const full = { from: 0, to: 8 * HOUR }

test('the whole window is no view at all, not a view that looks like it', () => {
  assert.equal(viewFromRange({ from: 0, to: 8 * HOUR }, full), null)
  assert.equal(viewFromRange({ from: 500, to: 8 * HOUR - 500 }, full), null)
  assert.deepEqual(viewFromRange({ from: HOUR, to: 2 * HOUR }, full), { from: HOUR, to: 2 * HOUR, follow: false })
})

test('a slice touching the newest edge follows it', () => {
  assert.equal(viewFromRange({ from: 7 * HOUR, to: 8 * HOUR }, full).follow, true)
  assert.equal(viewFromRange({ from: 6 * HOUR, to: 7 * HOUR }, full).follow, false)
})

test('zooming in halves nothing it should not: factor 1.5 around the centre', () => {
  const view = zoomBy(null, full, ZOOM_STEP)
  const span = 8 * HOUR / ZOOM_STEP
  assert.equal(Math.round(view.to - view.from), Math.round(span))
  assert.equal(Math.round((view.from + view.to) / 2), 4 * HOUR)
  assert.equal(zoomPercent(view, full), 150)
})

test('zooming out from a view widens it and lands back on "no zoom"', () => {
  let view = zoomBy(null, full, ZOOM_STEP)
  view = zoomBy(view, full, ZOOM_STEP)
  assert.ok(zoomPercent(view, full) > 200)
  for (let i = 0; i < 12 && view; i += 1) view = zoomBy(view, full, 1 / ZOOM_STEP)
  assert.equal(view, null)
  assert.equal(zoomPercent(null, full), 100)
})

test('zooming out at the whole window stays there', () => {
  assert.equal(zoomBy(null, full, 1 / ZOOM_STEP), null)
  assert.equal(canZoomOut(null, full), false)
})

test('zoom in stops at the narrowest view', () => {
  let view = null
  for (let i = 0; i < 60; i += 1) view = zoomBy(view, full, ZOOM_STEP)
  assert.ok(view.to - view.from >= minSpan(full) - 1)
  assert.equal(canZoomIn(view, full), false)
  assert.equal(canZoomIn(null, full), true)
})

test('zooming keeps the view inside the window', () => {
  const edge = { from: 7.5 * HOUR, to: 8 * HOUR, follow: true }
  const view = zoomBy(edge, full, 1 / ZOOM_STEP)
  assert.ok(view.from >= full.from && view.to <= full.to)
  // Anchored to the newest edge: zooming out of a followed view keeps it on screen.
  assert.equal(view.to, full.to)
})

test('a followed view rides the window forward; a fixed one stays put', () => {
  const followed = { from: 7 * HOUR, to: 8 * HOUR, follow: true }
  const fixed = { from: 2 * HOUR, to: 3 * HOUR, follow: false }
  const slid = { from: 5_000, to: 8 * HOUR + 5_000 }       // window moved 5 s on
  assert.deepEqual(resolveView(followed, slid), { from: 7 * HOUR + 5_000, to: 8 * HOUR + 5_000, follow: true })
  assert.deepEqual(resolveView(fixed, slid), fixed)
})

test('a fixed view that has slid out of the window is dropped', () => {
  const gone = { from: 0, to: HOUR, follow: false }
  assert.equal(resolveView(gone, { from: 2 * HOUR, to: 10 * HOUR }), null)
})

test('a dragged box zooms to its span, in either direction, clamped to the window', () => {
  assert.deepEqual(selectionToView(3 * HOUR, 2 * HOUR, full), { from: 2 * HOUR, to: 3 * HOUR, follow: false })
  const clamped = selectionToView(-HOUR, 9 * HOUR, full)
  assert.equal(clamped, null)                                  // that is the whole window
  assert.equal(selectionToView(2 * HOUR, 2 * HOUR + 100, full), null)   // a click
})

test('wheel always zooms; dragging pans only with the hand tool', () => {
  const [inside] = buildDataZoom({ long: false, view: null, hand: false })
  assert.equal(inside.zoomOnMouseWheel, true)
  assert.equal(inside.moveOnMouseMove, false)
  assert.deepEqual([inside.start, inside.end], [0, 100])
  const [pan] = buildDataZoom({ long: false, view: { from: 1, to: 2 }, hand: true })
  assert.equal(pan.moveOnMouseMove, true)
  assert.deepEqual([pan.startValue, pan.endValue], [1, 2])
})

test('a slider joins on long windows and shares the view', () => {
  const zoom = buildDataZoom({ long: true, view: { from: 1, to: 2 }, hand: false })
  assert.deepEqual(zoom.map((z) => z.type), ['inside', 'slider'])
  assert.deepEqual([zoom[1].startValue, zoom[1].endValue], [1, 2])
})

test('the zoom buttons step through fixed levels', async () => {
  const { ZOOM_LEVELS, zoomLevel, nextLevel } = await import('./trendZoom.js')
  const week = { from: 0, to: 7 * 24 * HOUR }
  let view = zoomLevel(null, week, 1)
  assert.equal(view.to - view.from, 3 * 24 * HOUR)
  view = zoomLevel(view, week, 1)
  assert.equal(view.to - view.from, 2 * 24 * HOUR)
  // From a free wheel zoom (say 70 min) the next level in is the next one below.
  const free = { from: 10 * HOUR, to: 10 * HOUR + 70 * 60_000, follow: false }
  assert.equal(nextLevel(free, week, 1), HOUR)
  assert.equal(nextLevel(free, week, -1), 2 * HOUR)
  // Out past the widest level below the window is the whole window.
  assert.equal(zoomLevel({ from: 0, to: 3 * 24 * HOUR, follow: false }, week, -1), null)
  assert.ok(ZOOM_LEVELS.every((l, i) => i === 0 || l > ZOOM_LEVELS[i - 1]))
})

test('a pan keeps the time under the finger where the finger is', () => {
  const span = 2 * HOUR
  // Finger went down at 4 h, a quarter in; it is now at the middle.
  const { view, overshoot } = frameAt(full, 4 * HOUR, 0.5, span)
  assert.deepEqual(view, { from: 3 * HOUR, to: 5 * HOUR, follow: false })
  assert.equal(overshoot, 0)
})

test('a pan past the edge stops at it and reports how far it was pushed', () => {
  const { view, overshoot } = frameAt(full, HOUR, 1, 2 * HOUR)
  assert.equal(view.from, 0)
  assert.equal(overshoot, -HOUR)
  const end = frameAt(full, 7 * HOUR, 0, 2 * HOUR)
  assert.equal(end.view.to, 8 * HOUR)
  assert.equal(end.view.follow, true)
  assert.equal(end.overshoot, HOUR)
})

test('at the whole window a pan has nowhere to go, only an overshoot', () => {
  const { view, overshoot } = frameAt(full, 4 * HOUR, 0.6, 8 * HOUR)
  assert.equal(view, null)
  assert.ok(overshoot < 0)
})

test('a pinch rescales around the anchor and never past the floors', () => {
  const { view } = frameAt(full, 4 * HOUR, 0.5, HOUR)
  assert.deepEqual(view, { from: 3.5 * HOUR, to: 4.5 * HOUR, follow: false })
  const tiny = frameAt(full, 4 * HOUR, 0.5, 1).view
  assert.equal(tiny.to - tiny.from, minSpan(full))
  assert.equal(frameAt(full, 4 * HOUR, 0.5, 100 * HOUR).view, null)
})

test('pinch geometry is the distance and the midpoint', () => {
  assert.deepEqual(pinchGeometry({ x: 0, y: 0 }, { x: 30, y: 40 }), { dist: 50, mid: { x: 15, y: 20 } })
})
