import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clusterMessages, escapeHtml, messagesBetween, messagesNear, normalizeMessages,
} from './alertFlags.js'

const MIN = 60_000
const view = { from: 0, to: 100 * MIN }

const msg = (minute, severity = 'info', message = `m${minute}`) => ({ t: minute * MIN, message, severity })

test('rows are normalised oldest first, bad times dropped, unknown severity is info', () => {
  const out = normalizeMessages([
    { ts: '2026-10-18T10:05:00+07:00', message: 'b', severity: 'crit', severity_raw: 'ALARM' },
    { ts: 'not a time', message: 'x', severity: 'warn' },
    { ts: '2026-10-18T10:00:00+07:00', message: 'a', severity: 'loud' },
  ])
  assert.deepEqual(out.map((m) => m.message), ['a', 'b'])
  assert.equal(out[0].severity, 'info')
  assert.equal(out[1].severityRaw, 'ALARM')
})

test('flags far apart stay separate, at their place across the plot', () => {
  const flags = clusterMessages([msg(10), msg(50)], view, 1000)
  assert.equal(flags.length, 2)
  assert.equal(flags[0].frac, 0.1)
  assert.equal(flags[1].frac, 0.5)
  assert.equal(flags[0].count, 1)
})

test('flags closer than the gap merge, take the worst severity and list newest first', () => {
  // 1 min = 10 px on a 1000 px plot of 100 min.
  const flags = clusterMessages([msg(10, 'info'), msg(11, 'crit'), msg(12, 'warn'), msg(40)], view, 1000, 25)
  assert.equal(flags.length, 2)
  assert.equal(flags[0].count, 3)
  assert.equal(flags[0].severity, 'crit')
  assert.deepEqual(flags[0].messages.map((m) => m.message), ['m12', 'm11', 'm10'])
  assert.equal(flags[0].from, 10 * MIN)
  assert.equal(flags[0].to, 12 * MIN)
  assert.ok(Math.abs(flags[0].frac - 0.11) < 1e-9)
})

test('zooming in pulls a cluster apart', () => {
  const messages = [msg(10), msg(11)]
  assert.equal(clusterMessages(messages, view, 1000, 14).length, 1)
  assert.equal(clusterMessages(messages, { from: 0, to: 20 * MIN }, 1000, 14).length, 2)
})

test('messages outside the view are not drawn; a degenerate plot draws nothing', () => {
  assert.equal(clusterMessages([msg(150)], view, 1000).length, 0)
  assert.equal(clusterMessages([msg(10)], view, 0).length, 0)
  assert.equal(clusterMessages([msg(10)], { from: 5, to: 5 }, 1000).length, 0)
})

test('the tooltip lists messages near the hovered time, newest first', () => {
  const messages = [msg(10), msg(11), msg(20)]
  assert.deepEqual(messagesNear(messages, 10.5 * MIN, MIN).map((m) => m.message), ['m11', 'm10'])
  assert.deepEqual(messagesNear(messages, 15 * MIN, MIN), [])
  assert.deepEqual(messagesNear(messages, NaN, MIN), [])
})

test('a pinned box holds its messages by time, whatever the zoom', () => {
  const messages = [msg(10), msg(11), msg(12), msg(30)]
  assert.deepEqual(messagesBetween(messages, 10 * MIN, 12 * MIN).map((m) => m.message), ['m12', 'm11', 'm10'])
})

test('plant text is escaped before it reaches tooltip markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">&\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;')
  assert.equal(escapeHtml(null), '')
})

test('a steady stream does not chain into one flag: a cluster is at most the gap wide', () => {
  // A message every minute = every 10 px; with a 25 px gap each flag holds 3.
  const stream = Array.from({ length: 30 }, (_, i) => msg(i))
  const flags = clusterMessages(stream, view, 1000, 25)
  assert.equal(flags.length, 10)
  assert.ok(flags.every((f) => f.count === 3))
  assert.equal(flags.reduce((n, f) => n + f.count, 0), 30)
})
