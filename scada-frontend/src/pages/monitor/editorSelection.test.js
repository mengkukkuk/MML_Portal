import test from 'node:test'
import assert from 'node:assert/strict'
import { moveGroup, nodesInRect } from './editorSelection.js'

const nodes = [
  { id: 'a', x: 100, y: 100, w: 50, h: 50 },
  { id: 'b', x: 300, y: 100, w: 50, h: 50 },
  { id: 'c', x: 100, y: 400, w: 50, h: 50 },
]
const sheet = { w: 1600, h: 900 }

test('a box selects every symbol it touches, dragged in any direction', () => {
  assert.deepEqual(nodesInRect(nodes, { x: 90, y: 90 }, { x: 320, y: 160 }), ['a', 'b'])
  assert.deepEqual(nodesInRect(nodes, { x: 320, y: 160 }, { x: 90, y: 90 }), ['a', 'b'], 'reversed corners')
  assert.deepEqual(nodesInRect(nodes, { x: 140, y: 140 }, { x: 145, y: 145 }), ['a'], 'touching is enough')
  assert.deepEqual(nodesInRect(nodes, { x: 500, y: 500 }, { x: 600, y: 600 }), [])
})

test('a group moves by one delta and keeps its arrangement', () => {
  const origins = nodes.slice(0, 2)
  assert.deepEqual(moveGroup(origins, 20, 30, sheet), [
    { id: 'a', x: 120, y: 130 },
    { id: 'b', x: 320, y: 130 },
  ])
})

test('the group stops as one block at the sheet edge instead of squashing', () => {
  const origins = nodes.slice(0, 2)
  // a is 100 from the left edge: a 500 move left can only go 100.
  const moved = moveGroup(origins, -500, 0, sheet)
  assert.deepEqual(moved.map((m) => m.x), [0, 200], 'spacing of 200 preserved')
  // b's right edge is at 350: only 1250 more fits.
  assert.deepEqual(moveGroup(origins, 5000, 0, sheet).map((m) => m.x), [1350, 1550])
})

test('a bigger sheet lets the group travel further', () => {
  const big = { w: 4800, h: 2700 }
  assert.deepEqual(moveGroup([nodes[0]], 3000, 2000, big), [{ id: 'a', x: 3100, y: 2100 }])
})
