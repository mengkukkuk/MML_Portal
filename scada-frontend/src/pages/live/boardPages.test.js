import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pageOf, pageCount, clampPage, panelsOnPage, stepPage, shiftAfterRemoving, pageFromQuery, firstFreeSlot, MAX_PAGES,
} from './boardPages.js'

const P = (id, page) => ({ id, options: page === undefined ? {} : { page } })

test('a panel without a page is on the first; bad pages are too', () => {
  assert.equal(pageOf(P(1)), 0)
  assert.equal(pageOf(P(1, 2)), 2)
  for (const bad of [-1, 1.5, 'x', null]) assert.equal(pageOf(P(1, bad)), 0)
})

test('the board count is its own, never below 1 or above the cap', () => {
  assert.equal(pageCount({ page_count: 3 }), 3)
  assert.equal(pageCount({}), 1)
  assert.equal(pageCount({ page_count: 0 }), 1)
  assert.equal(pageCount({ page_count: 99 }), MAX_PAGES)
})

test('a panel past the last page shows on the last, so none is unreachable', () => {
  const panels = [P(1), P(2, 1), P(3, 5)]
  assert.deepEqual(panelsOnPage(panels, 0, 2).map((p) => p.id), [1])
  assert.deepEqual(panelsOnPage(panels, 1, 2).map((p) => p.id), [2, 3])
  assert.equal(clampPage(7, 3), 2)
  assert.equal(clampPage(-2, 3), 0)
})

test('arrows wrap around', () => {
  assert.equal(stepPage(2, 1, 3), 0)
  assert.equal(stepPage(0, -1, 3), 2)
  assert.equal(stepPage(0, 1, 1), 0)
})

test('deleting a page slides later pages down, keeping their order', () => {
  const moves = shiftAfterRemoving([P(1), P(2, 2), P(3, 3), P(4, 1)], 1, 4)
  assert.deepEqual(moves.map((m) => [m.panel.id, m.page]), [[2, 1], [3, 2]])
})

test('?page= is 1-based', () => {
  assert.equal(pageFromQuery('2'), 1)
  assert.equal(pageFromQuery(null), null)
  assert.equal(pageFromQuery('0'), null)
  assert.equal(pageFromQuery('x'), null)
})

test('a moved panel takes the first gap that fits, side by side', () => {
  assert.deepEqual(firstFreeSlot([], 6, 9), { x: 0, y: 0, w: 6, h: 9 })
  assert.deepEqual(firstFreeSlot([{ x: 0, y: 0, w: 6, h: 9 }], 6, 9), { x: 6, y: 0, w: 6, h: 9 })
  const full = [{ x: 0, y: 0, w: 6, h: 9 }, { x: 6, y: 0, w: 6, h: 9 }]
  assert.deepEqual(firstFreeSlot(full, 6, 9), { x: 0, y: 9, w: 6, h: 9 })
  assert.deepEqual(firstFreeSlot([{ x: 0, y: 0, w: 8, h: 9 }], 6, 9), { x: 0, y: 9, w: 6, h: 9 })
  assert.equal(firstFreeSlot([], 20, 4).w, 12)
})
