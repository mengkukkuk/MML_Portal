import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUBBLE_SHAPES, bubbleGeometry, bubbleHidden, bubbleShape, bubbleSplitInset, bubbleTextWidth,
} from './bubbleShape.js'

test('a missing or unknown shape is the circle, so older drawings are unchanged', () => {
  assert.equal(bubbleShape(undefined), 'circle')
  assert.equal(bubbleShape({}), 'circle')
  assert.equal(bubbleShape({ bubbleShape: 'hexagon' }), 'circle')
  assert.equal(bubbleShape({ bubbleShape: 'pill' }), 'pill')
})

test('every offered shape resolves to itself', () => {
  for (const { id } of BUBBLE_SHAPES) assert.equal(bubbleShape({ bubbleShape: id }), id)
})

test('only an explicit true hides the balloon', () => {
  assert.equal(bubbleHidden({ options: { bubbleHidden: true } }), true)
  assert.equal(bubbleHidden({ options: { bubbleHidden: false } }), false)
  assert.equal(bubbleHidden({ options: {} }), false)
  assert.equal(bubbleHidden({}), false)
  assert.equal(bubbleHidden(null), false)
})

test('the circle keeps its ISA proportions at any size', () => {
  assert.deepEqual(bubbleGeometry('circle', 34), { hw: 34, hh: 34, rx: 34 })
  assert.deepEqual(bubbleGeometry('circle', 20), { hw: 20, hh: 20, rx: 20 })
})

test('the wide shapes grow sideways and are shorter than the circle', () => {
  for (const shape of ['box', 'pill']) {
    const g = bubbleGeometry(shape, 34)
    assert.ok(g.hw > 34, `${shape} is wider than the circle`)
    assert.ok(g.hh < 34, `${shape} is shorter than the circle`)
    // The unit row sits 24 units below centre at the default size.
    assert.ok(g.hh > 26, `${shape} still holds the unit row`)
  }
})

test('a pill is fully rounded and a box is not', () => {
  const pill = bubbleGeometry('pill', 34)
  assert.equal(pill.rx, pill.hh)
  assert.ok(bubbleGeometry('box', 34).rx < bubbleGeometry('box', 34).hh / 2)
})

test('the wider of the reading and the tag decides how much text there is', () => {
  const long = bubbleTextWidth('123,456,780.0', 'XT')
  assert.ok(long > 104, 'a 13-character reading measures about 104 units')
  assert.ok(bubbleTextWidth('7', 'n new-mujwykvt-1') > 120, 'a long loop id counts too')
  assert.equal(bubbleTextWidth('', ''), 0)
  assert.equal(bubbleTextWidth(), 0)
})

test('a box or pill widens for long text and never narrows below its base', () => {
  const reading = bubbleTextWidth('123,456,780.0', 'PT-1')
  const loopId = bubbleTextWidth('7', 'n new-mujwykvt-1')
  for (const shape of ['box', 'pill']) {
    const base = bubbleGeometry(shape, 34).hw
    assert.equal(bubbleGeometry(shape, 34, bubbleTextWidth('7', 'PT-1')).hw, base,
      'short text keeps the base width')
    // Room either side of the widest row, not just enough to hold it.
    assert.ok(bubbleGeometry(shape, 34, reading).hw * 2 >= reading + 24)
    assert.ok(bubbleGeometry(shape, 34, loopId).hw * 2 >= loopId + 24)
    assert.equal(bubbleGeometry(shape, 34, reading).hh, bubbleGeometry(shape, 34).hh,
      'height never changes')
  }
})

test('the circle and square ignore how much text there is', () => {
  assert.deepEqual(bubbleGeometry('circle', 34, 200), bubbleGeometry('circle', 34))
  assert.deepEqual(bubbleGeometry('square', 34, 200), bubbleGeometry('square', 34))
})

test('widening for text scales with the size setting', () => {
  assert.equal(bubbleGeometry('box', 68, 109).hw, bubbleGeometry('box', 34, 109).hw * 2)
})

test('geometry scales linearly with the size setting', () => {
  const a = bubbleGeometry('box', 34)
  const b = bubbleGeometry('box', 68)
  assert.equal(b.hw, a.hw * 2)
  assert.equal(b.hh, a.hh * 2)
})

test('square outlines are met flush by the hairline, rounded ones are inset', () => {
  assert.equal(bubbleSplitInset('square', 1), 0)
  assert.equal(bubbleSplitInset('box', 2), 0)
  assert.equal(bubbleSplitInset('circle', 2), 6)
  assert.equal(bubbleSplitInset('pill', 1), 3)
})
