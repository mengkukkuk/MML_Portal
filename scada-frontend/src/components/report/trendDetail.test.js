import test from 'node:test'
import assert from 'node:assert/strict'
import { STEP_LADDER, TILE_BUCKETS, spanLabel, spliceDetail, tierStep, tilesFor } from './trendDetail.js'

const H = 3_600_000
const D = 24 * H
const full = { from: 0, to: 30 * D }

test('tierStep picks the ladder step that gives at least two buckets a pixel', () => {
  // A week over 1500 px: 201.6 s a bucket wanted, so 5 min.
  assert.equal(tierStep(7 * D, 1500), 300)
  // Seven hours over 1500 px: 8.4 s, so 10 s — every row of a 10 s logger.
  assert.equal(tierStep(7 * H, 1500), 10)
  assert.ok(STEP_LADDER.includes(tierStep(30 * D, 1500)))
})

test('tierStep is stable inside a tier: a small zoom asks for the same step', () => {
  assert.equal(tierStep(7 * H, 1500), tierStep(6.5 * H, 1500))
})

test('tierStep goes past a day for very long spans', () => {
  assert.equal(tierStep(366 * D * 10, 200) % 86_400, 0)
})

test('tilesFor is empty without a view', () => {
  assert.deepEqual(tilesFor(null, full, 10), [])
})

test('tiles sit on a fixed grid, whatever view asked for them', () => {
  const step = 10
  const size = step * 1000 * TILE_BUCKETS
  const a = tilesFor({ from: 10 * D, to: 10 * D + 7 * H }, full, step)
  const b = tilesFor({ from: 10 * D + 60_000, to: 10 * D + 7 * H + 60_000 }, full, step)
  assert.deepEqual(a, b)
  for (const tile of a) {
    assert.equal(tile.from % size, 0)
    assert.equal(tile.to - tile.from, size)
    assert.equal(tile.step, step)
  }
})

test('tiles cover the padded view and stay near the window', () => {
  const view = { from: 10 * D, to: 10 * D + 7 * H }
  const tiles = tilesFor(view, full, 10)
  assert.ok(tiles[0].from <= view.from - 3.5 * H)
  assert.ok(tiles.at(-1).to >= view.to + 3.5 * H)
  assert.ok(tiles.length <= 4)
  const edge = tilesFor({ from: full.to - H, to: full.to }, full, 10)
  assert.ok(edge.at(-1).from < full.to)
})

const overview = [0, 10, 20, 30, 40].map((t) => ({ t, v: ['coarse'] }))
const detail = [11, 12, 13, 25, 29].map((t) => ({ t, v: ['fine'] }))

test('spliceDetail replaces the overview inside the range with the detail', () => {
  const out = spliceDetail(overview, detail, { from: 11, to: 30 })
  assert.deepEqual(out.map((p) => p.t), [0, 10, 11, 12, 13, 25, 29, 30, 40])
  assert.deepEqual(out.filter((p) => p.v[0] === 'coarse').map((p) => p.t), [0, 10, 30, 40])
})

test('spliceDetail returns the overview untouched without detail', () => {
  assert.equal(spliceDetail(overview, null, { from: 0, to: 1 }), overview)
})

test('spanLabel reads in the unit that fits', () => {
  assert.equal(spanLabel(H), '1 h')
  assert.equal(spanLabel(6 * H), '6 h')
  assert.equal(spanLabel(7 * D), '7 d')
  assert.equal(spanLabel(30_000), '30 s')
  assert.equal(spanLabel(2.5 * D), '2.5 d')
})

test('cadenceOf is the median gap, and floorStep the tier it allows', async () => {
  const { cadenceOf, floorStep } = await import('./trendDetail.js')
  const rows = [0, 10, 20, 30, 45, 55].map((s) => ({ t: s * 1000 }))
  assert.equal(cadenceOf(rows), 10)
  assert.equal(cadenceOf(rows.slice(0, 2)), null)
  assert.equal(floorStep(10), 10)
  assert.equal(floorStep(12), 10)
  assert.equal(floorStep(null), 1)
})
