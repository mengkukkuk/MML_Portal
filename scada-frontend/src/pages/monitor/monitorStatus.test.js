import test from 'node:test'
import assert from 'node:assert/strict'
import {
  connectionCounts, overviewSubtitle, plantStatusOf, rankAttention, statusLabelOf,
} from './monitorStatus.js'

const bound = (id, ds) => ({ id, binding: { table: 't', value_col: 'v', datasource_id: ds } })

test('plant status is the worst status among the drawing nodes only', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }]
  assert.equal(plantStatusOf(nodes, {}), 'normal')
  assert.equal(plantStatusOf(nodes, { a: { status: 'warn' } }), 'warn')
  assert.equal(plantStatusOf(nodes, { a: { status: 'warn' }, b: { status: 'crit' } }), 'crit')
  // A tag that is not on the drawing (e.g. a KPI box) must not light the banner.
  assert.equal(plantStatusOf(nodes, { kpi: { status: 'crit' } }), 'normal')
})

test('status label reads the same word everywhere', () => {
  assert.equal(statusLabelOf('crit'), 'Alarm')
  assert.equal(statusLabelOf('warn'), 'Off normal')
  assert.equal(statusLabelOf('normal'), 'Running')
})

test('attention ranks alarm, off normal, not connected, then healthy — sheet order within a rank', () => {
  const nodes = [{ id: 'ok1' }, { id: 'none' }, { id: 'warn' }, { id: 'crit' }, { id: 'ok2' }]
  const tags = {
    ok1: { status: 'normal' }, warn: { status: 'warn' }, crit: { status: 'crit' }, ok2: { status: 'normal' },
  }
  const r = rankAttention(nodes, tags)
  assert.deepEqual(r.ordered.map((x) => x.node.id), ['crit', 'warn', 'none', 'ok1', 'ok2'])
  assert.deepEqual([r.crit, r.warn, r.unbound], [1, 1, 1])
})

test('connection counts treat a missing datasource as the app database', () => {
  assert.deepEqual(connectionCounts([bound('a'), bound('b'), { id: 'c' }]), { connected: 2, backendCount: 1 })
  assert.deepEqual(connectionCounts([bound('a', 1), bound('b', 2)]), { connected: 2, backendCount: 2 })
  assert.deepEqual(connectionCounts([]), { connected: 0, backendCount: 0 })
})

test('subtitle describes empty, unconnected and connected drawings', () => {
  assert.match(overviewSubtitle(0, 0, 0), /^Empty drawing/)
  assert.equal(overviewSubtitle(1, 0, 0), 'No symbols connected yet')
  assert.equal(overviewSubtitle(3, 2, 1), '2 of 3 symbols connected · 1 connection')
  assert.equal(overviewSubtitle(2, 2, 2), '2 of 2 symbols connected · 2 connections')
})
