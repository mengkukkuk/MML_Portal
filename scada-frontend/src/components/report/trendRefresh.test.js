import test from 'node:test'
import assert from 'node:assert/strict'
import { formatEvery, trendRefreshMs, windowSpanMs } from './trendRefresh.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

test('short windows follow the global interval exactly', () => {
  assert.equal(trendRefreshMs(5, 10 * 60_000), 5000)
  assert.equal(trendRefreshMs(2, DAY), 2000)
})

test('long windows are stretched so a season is not re-read every few seconds', () => {
  assert.equal(trendRefreshMs(5, 3 * DAY), 15_000)
  assert.equal(trendRefreshMs(5, 30 * DAY), 60_000)
  // A slower preference is never sped up.
  assert.equal(trendRefreshMs(120, 30 * DAY), 120_000)
})

test('a missing or nonsense interval falls back to 5 s and never goes under 1 s', () => {
  assert.equal(trendRefreshMs(undefined, HOUR), 5000)
  assert.equal(trendRefreshMs(0, HOUR), 5000)
  assert.equal(trendRefreshMs(0.2, HOUR), 1000)
})

test('window length is minutes for a relative window, end minus start for a custom one', () => {
  assert.equal(windowSpanMs({ minutes: 480 }), 8 * HOUR)
  assert.equal(
    windowSpanMs({ minutes: 'custom', start: '2026-09-08T00:00:00Z', end: '2026-09-09T00:00:00Z' }),
    DAY,
  )
})

test('the interval reads as a short phrase', () => {
  assert.equal(formatEvery(5000), '5 s')
  assert.equal(formatEvery(60_000), '1 min')
  assert.equal(formatEvery(120_000), '2 min')
})
