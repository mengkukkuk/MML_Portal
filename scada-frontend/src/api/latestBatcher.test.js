import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatestBatcher } from './latestBatcher.js'

const ok = (value) => ({ status: 200, readings: [{ value }], sources: [{ ok: true }] })

function recorder(respond) {
  const calls = []
  const post = (items) => {
    calls.push(items)
    return respond(items)
  }
  return { calls, post }
}

test('reads issued together leave as one request, answered in order', async () => {
  const { calls, post } = recorder(async (items) => items.map((it) => ok(it.value_col)))
  const fetch = createLatestBatcher(post, { windowMs: 0 })
  const answers = await Promise.all(['a', 'b', 'c'].map((v) => fetch({ value_col: v })))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].map((it) => it.value_col), ['a', 'b', 'c'])
  assert.deepEqual(answers.map((a) => a.readings[0].value), ['a', 'b', 'c'])
})

test('a failed binding rejects alone, in the axios shape the UI already reads', async () => {
  const detail = { error: 'No matching row', sources: [{ datasource_id: 1, ok: true }] }
  const { post } = recorder(async () => [ok(1), { status: 404, sources: detail.sources, detail }])
  const fetch = createLatestBatcher(post, { windowMs: 0 })
  const [good, bad] = await Promise.allSettled([fetch({}), fetch({})])
  assert.equal(good.status, 'fulfilled')
  assert.equal(bad.status, 'rejected')
  assert.equal(bad.reason.response.status, 404)
  assert.deepEqual(bad.reason.response.data.detail.sources, detail.sources)
  assert.equal(bad.reason.message, 'No matching row')
})

test('a transport failure rejects every member with the same error', async () => {
  const boom = new Error('Network Error')
  const { post } = recorder(async () => { throw boom })
  const fetch = createLatestBatcher(post, { windowMs: 0 })
  const settled = await Promise.allSettled([fetch({}), fetch({})])
  assert.deepEqual(settled.map((s) => s.reason), [boom, boom])
})

test('large rounds are split into chunks', async () => {
  const { calls, post } = recorder(async (items) => items.map(() => ok(0)))
  const fetch = createLatestBatcher(post, { windowMs: 0, maxBatch: 2 })
  await Promise.all([1, 2, 3, 4, 5].map((v) => fetch({ v })))
  assert.deepEqual(calls.map((c) => c.length), [2, 2, 1])
})

test('reads after a flush start a new batch', async () => {
  const { calls, post } = recorder(async (items) => items.map(() => ok(0)))
  const fetch = createLatestBatcher(post, { windowMs: 0 })
  await fetch({})
  await fetch({})
  assert.equal(calls.length, 2)
})

test('a short response rejects the unanswered members instead of hanging', async () => {
  const { post } = recorder(async () => [ok(1)])
  const fetch = createLatestBatcher(post, { windowMs: 0 })
  const settled = await Promise.allSettled([fetch({}), fetch({})])
  assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'rejected'])
})
