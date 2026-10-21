import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtPieces, fmtBaht, fmtDuration, lossMeterFigures, lossDelta, appendSpark,
  waterfallBars, stripSegments, andonWord,
} from './kpiView.js'

const tr = (s, p = {}) => s.replace(/\{(\w+)\}/g, (_, k) => p[k])

const SUMMARY = {
  totals: {
    potential: 61200, stop_loss: 7450, slow_loss: 2390, defects: 4017, good: 47343,
    lost: 9840, pending: 108,
    baht: { defects: 48204, lost: 118080, pending: 1296, total: 166284 },
  },
  compare: { defects: 3759, lost: 9310, baht: { defects: 45108, lost: 111720, total: 156828 } },
}

test('formats pieces and baht', () => {
  assert.equal(fmtPieces(4017.4), '4,017')
  assert.equal(fmtBaht(48204.2), '฿48,204')
  assert.equal(fmtBaht(null), '—')
})

test('durations read naturally', () => {
  assert.equal(fmtDuration(12, tr), '12 min')
  assert.equal(fmtDuration(320, tr), '5 h 20 min')
  assert.equal(fmtDuration(120, tr), '2 h')
  assert.equal(fmtDuration(60 * 29, tr), '1 d 5 h')
})

test('loss meter picks figures by mode', () => {
  const d = lossMeterFigures(SUMMARY, 'defects')
  assert.equal(d.baht, 48204)
  assert.equal(d.deltaBaht, 48204 - 45108)
  assert.equal(d.pendingPieces, 0)
  const l = lossMeterFigures(SUMMARY, 'lost')
  assert.equal(l.pieces, 9840)
  assert.equal(l.pendingBaht, 1296)
  const t = lossMeterFigures(SUMMARY, 'total')
  assert.equal(t.pieces, 4017 + 9840)
  assert.equal(t.baht, 166284)
})

test('loss meter without cost shows pieces only', () => {
  const noCost = { totals: { ...SUMMARY.totals, baht: undefined }, compare: { defects: 1, lost: 1 } }
  const f = lossMeterFigures(noCost, 'lost')
  assert.equal(f.baht, null)
  assert.equal(f.pendingBaht, null)
  assert.equal(f.deltaPieces, 9839)
})

test('for a loss, up is bad', () => {
  assert.deepEqual(lossDelta(3100), { arrow: '▲', tone: 'bad' })
  assert.deepEqual(lossDelta(-5), { arrow: '▼', tone: 'good' })
  assert.deepEqual(lossDelta(0.2), { arrow: '=', tone: 'flat' })
  assert.equal(lossDelta(null), null)
})

test('sparkline appends, caps, and restarts on a new period', () => {
  let pts = []
  pts = appendSpark(pts, 1, 10)
  pts = appendSpark(pts, 2, 12)
  pts = appendSpark(pts, 2, 13)
  assert.deepEqual(pts, [[1, 10], [2, 12]])
  assert.deepEqual(appendSpark(pts, 3, 5), [[3, 5]])
  assert.equal(appendSpark([[1, 1], [2, 2]], 3, 3, 2).length, 2)
})

test('waterfall balances and flags the largest loss', () => {
  const bars = waterfallBars(SUMMARY.totals)
  assert.deepEqual(bars.map((b) => b.key), ['potential', 'stop_loss', 'slow_loss', 'defects', 'good'])
  assert.equal(bars[0].height, 1)
  const defects = bars[3]
  assert.ok(Math.abs(defects.bottom - 47343 / 61200) < 1e-9)
  assert.ok(Math.abs(bars[4].height - defects.bottom) < 1e-9)
  assert.deepEqual(bars.filter((b) => b.largest).map((b) => b.key), ['stop_loss'])
})

test('waterfall of nothing does not divide by zero', () => {
  const bars = waterfallBars({ potential: 0, stop_loss: 0, slow_loss: 0, defects: 0, good: 0 })
  assert.ok(bars.every((b) => b.height === 0 && !b.largest))
})

test('strip segments span the strip', () => {
  const strip = [
    { start: '2026-10-21T00:00:00Z', end: '2026-10-21T06:00:00Z', state: 'off' },
    { start: '2026-10-21T06:00:00Z', end: '2026-10-21T12:00:00Z', state: 'run' },
  ]
  const segs = stripSegments(strip, Date.parse('2026-10-21T12:00:00Z'))
  assert.deepEqual(segs, [{ state: 'off', pct: 50 }, { state: 'run', pct: 50 }])
})

test('andon word carries the stop duration', () => {
  const now = Date.parse('2026-10-21T07:30:00Z')
  assert.equal(andonWord({ state: 'stop', state_since: '2026-10-21T07:18:00Z' }, tr, now), 'Stopped 12 min')
  assert.equal(andonWord({ state: 'run' }, tr, now), 'Running')
  assert.equal(andonWord(undefined, tr, now), 'No data')
})
