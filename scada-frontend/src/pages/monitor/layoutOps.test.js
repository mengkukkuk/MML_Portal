import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEdge, buildNewNode, buildPastedNode, findParallelEdge, newEdgeId, newNodeId,
  nudgeNode, nudgeNodes, patchTheme, removeNodes, resetNodeSize, rotateNode,
} from './layoutOps.js'

const doc = () => ({
  viewBox: { w: 1000, h: 500 },
  nodes: [
    { id: 'a', x: 10, y: 10, w: 100, h: 50 },
    { id: 'b', x: 900, y: 440, w: 100, h: 50 },
    { id: 'c', x: 400, y: 200, w: 100, h: 50 },
  ],
  edges: [
    { id: 'e1', from: { node: 'a', port: 'r' }, to: { node: 'c', port: 'l' } },
    { id: 'e2', from: { node: 'c', port: 'r' }, to: { node: 'b', port: 'l' } },
  ],
})

test('nudging one node keeps it on the sheet', () => {
  const next = nudgeNode(doc(), 'a', -50, -50)
  assert.deepEqual([next.nodes[0].x, next.nodes[0].y], [0, 0])
  const far = nudgeNode(doc(), 'b', 80, 80)
  assert.deepEqual([far.nodes[1].x, far.nodes[1].y], [900, 450])
})

test('nudging a group moves it as one rigid block', () => {
  const next = nudgeNodes(doc(), ['a', 'c'], -50, 8)
  assert.deepEqual(next.nodes.map((n) => [n.x, n.y]), [[0, 18], [900, 440], [390, 208]])
  assert.equal(nudgeNodes(doc(), ['nope'], 5, 5).nodes[0].x, 10)
})

test('removing nodes takes their wires with them', () => {
  const next = removeNodes(doc(), ['c'])
  assert.deepEqual(next.nodes.map((n) => n.id), ['a', 'b'])
  assert.deepEqual(next.edges, [])
  assert.deepEqual(removeNodes(doc(), ['b']).edges.map((e) => e.id), ['e1'])
})

test('rotation normalises into 0–359', () => {
  assert.equal(rotateNode(doc(), 'a', 375).nodes[0].rot, 15)
  assert.equal(rotateNode(doc(), 'a', -90).nodes[0].rot, 270)
})

test('reset size keeps position and falls back to the current box', () => {
  const next = resetNodeSize(doc(), 'a', () => ({ w: 20, h: 10 }))
  assert.deepEqual(next.nodes[0], { id: 'a', x: 10, y: 10, w: 20, h: 10 })
  assert.equal(resetNodeSize(doc(), 'a', () => undefined).nodes[0].w, 100)
})

test('a wire drawn back the other way is the same wire', () => {
  const edges = doc().edges
  const hit = findParallelEdge(edges, { node: 'c', port: 'l' }, { node: 'a', port: 'r' })
  assert.equal(hit.id, 'e1')
  assert.equal(findParallelEdge(edges, { node: 'a', port: 'x' }, { node: 'c', port: 'l' }), undefined)
  const edge = buildEdge({ node: 'a', port: 'r' }, { node: 'b', port: 'l', extra: 1 }, 'steam')
  assert.deepEqual(edge.to, { node: 'b', port: 'l' })
  assert.equal(edge.service, 'steam')
  assert.equal(edge.flowNode, null)
})

test('new ids are unique and keep the n-new / e-new format', () => {
  const ids = new Set([newNodeId(), newNodeId(), newEdgeId()])
  assert.equal(ids.size, 3)
  assert.match(newNodeId(), /^n-new-[0-9a-z]+-\d+$/)
  assert.match(newEdgeId(), /^e-new-[0-9a-z]+-\d+$/)
})

test('a new node is centred, snapped and clamped to the sheet', () => {
  const def = { label: 'Pump', defaultSize: { w: 64, h: 64 } }
  const sheet = { w: 1000, h: 500 }
  const centred = buildNewNode({ def, type: 'pump', sheet, snap: true })
  assert.deepEqual([centred.x, centred.y], [472, 216])
  assert.equal('symbolId' in centred, false)
  const edge = buildNewNode({ def, type: 'custom', symbolId: 7, point: { x: 5000, y: -5000 }, sheet, snap: false })
  assert.deepEqual([edge.x, edge.y, edge.symbolId], [936, 0, 7])
})

test('a pasted node is offset per paste and stays on the sheet', () => {
  const sheet = { w: 1000, h: 500 }
  const src = { id: 'a', x: 10, y: 10, w: 100, h: 50, options: { k: 1 } }
  const first = buildPastedNode(src, sheet, 1)
  assert.deepEqual([first.x, first.y], [34, 34])
  assert.notEqual(first.id, 'a')
  assert.notEqual(first.options, src.options)
  assert.equal(buildPastedNode({ ...src, x: 890 }, sheet, 3).x, 900)
})

test('theme patches merge into the existing theme', () => {
  assert.deepEqual(patchTheme({ theme: { a: 1 } }, { b: 2 }).theme, { a: 1, b: 2 })
  assert.deepEqual(patchTheme({}, { b: 2 }).theme, { b: 2 })
})
