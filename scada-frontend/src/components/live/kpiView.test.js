import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtPieces, fmtBaht, fmtDuration, lossMeterFigures, lossDelta, appendSpark, fmtCompact,
  waterfallBars, stripSegments, andonWord, stripTiles, hourlyBars, paceGeometry, trendDelta, viaNote, eventWhen,
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

test('KPI strip shows the chosen metrics and hides money without cost', () => {
  const summary = {
    settings: { metrics: ['yield', 'risk_pieces', 'cost_total'] },
    metrics: { yield: 0.9856, defects: 214, risk_pieces: 1120, baht: { cost_total: 5000 } },
  }
  const tiles = stripTiles(summary)
  assert.deepEqual(tiles.map((t) => t.value), ['98.6%', '1,120', '฿5,000'])
  assert.equal(tiles[1].tone, 'bad')
  assert.equal(stripTiles({ ...summary, metrics: { ...summary.metrics, baht: undefined } }).length, 2)
})

test('hourly bars flag hours above the period average', () => {
  const { avg, bars } = hourlyBars([
    { start: 'a', pieces: 100, defects: 1, rate: 0.01 },
    { start: 'b', pieces: 100, defects: 3, rate: 0.03 },
    { start: 'c', pieces: 0, defects: 0, rate: null },
  ])
  assert.equal(avg, 0.02)
  assert.deepEqual(bars.map((b) => b.above), [false, true, false])
  assert.equal(bars[1].share, 1)
  assert.equal(bars[2].empty, true)
})

test('plan pace spans the whole period and marks stopped bands', () => {
  const g = paceGeometry({
    period: { start: '2026-10-21T00:00:00Z', end: '2026-10-21T12:00:00Z', full_end: '2026-10-22T00:00:00Z' },
    plan: { total: 1000, to_date: 500 },
    timeline: { size_min: 720, rows: [
      { start: '2026-10-21T00:00:00Z', good_cum: 400, potential_cum: 450, plan_cum: 500, state: 'stop' },
    ] },
  })
  assert.equal(g.top, 1000)
  assert.deepEqual(g.good[0], [0.5, 0.4])
  assert.equal(g.bands.length, 1)
  assert.deepEqual(g.plan[1], [1, 1])
})

test('trend delta knows which way is good', () => {
  const days = [{ y: 0.99, b: 5 }, { y: 0.98, b: 25 }]
  assert.equal(trendDelta(days, 'y').worse, true)
  assert.equal(trendDelta(days, 'b', false).worse, true)
})

test('response board: how an alert reached its owner', () => {
  assert.deepEqual(viaNote({ via: 'location', location: 'Line 13' }), ['rule for {l}', { l: 'Line 13' }, null])
  assert.equal(viaNote({ via: 'catch_all', location: 'L13' })[2], 'warn')
  assert.equal(viaNote({ via: 'catch_all', location: null })[0], 'global rule')
  assert.equal(viaNote({ via: 'tag' })[0], 'set on the alert row')
  assert.equal(viaNote({ via: null })[2], 'bad')
})

test('response board: one time for one alert, a range for a run', () => {
  const one = eventWhen({ start: '2026-10-19T00:31:00+07:00', end: '2026-10-19T00:31:00+07:00', count: 1 }, false, 'en-GB')
  const run = eventWhen({ start: '2026-10-19T00:31:00+07:00', end: '2026-10-19T00:34:00+07:00', count: 5 }, false, 'en-GB')
  assert.ok(!one.includes('–'))
  assert.ok(run.includes('–') && run.startsWith(one))
  assert.equal(eventWhen(null), '—')
})

test('short counts: k and M with two decimals, small numbers as they are', () => {
  assert.equal(fmtCompact(987), '987')
  assert.equal(fmtCompact(234567), '234.57 k')
  assert.equal(fmtCompact(1234567), '1.23 M')
  assert.equal(fmtCompact(2500000000), '2.50 B')
  assert.equal(fmtCompact(999995), '1.00 M')       // never "1000.00 k"
  assert.equal(fmtCompact(-234567), '-234.57 k')
  assert.equal(fmtCompact(null), '—')
})
