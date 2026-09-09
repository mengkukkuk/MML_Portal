import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTrendWindow, trendTimeAxis, windowError } from './trendWindow.js'
import { trendFromParams, paramsFromTrend, mergeParams, TREND_KEYS } from './trendParams.js'
import * as echarts from 'echarts'

test('eight hours uses requested bounds regardless of sample coverage', () => {
  const now = Date.parse('2026-09-09T16:00:00+07:00')
  const range = resolveTrendWindow({ minutes: 480 }, now)
  assert.deepEqual(trendTimeAxis(range), { type: 'time', min: now - 8 * 3600_000, max: now })
})

test('custom bounds preserve instants across midnight and timezone offsets', () => {
  const trend = { minutes: 'custom', start: '2026-09-08T23:00:00+07:00', end: '2026-09-09T02:00:00+07:00' }
  const range = resolveTrendWindow(trend)
  assert.equal(windowError(range.start, range.end), '')
  assert.equal(trendTimeAxis(range).max - trendTimeAxis(range).min, 3 * 3600_000)
})

test('invalid, missing, reversed and oversized dates are rejected', () => {
  for (const [start, end] of [['', ''], ['bad', '2026-09-09'],
    ['2026-09-09', '2026-09-09'], ['2026-09-10', '2026-09-09'],
    ['2026-09-01', '2026-09-09']]) assert.ok(windowError(start, end))
  assert.equal(windowError('2026-09-01', '2026-09-08'), '')
})

test('custom URL round-trip preserves OEE filters and array selections', () => {
  const original = new URLSearchParams('preset=custom&start=2026-01-01&end=2026-01-02&location=A&location=B')
  const trend = { ...trendFromParams(original), table: 'sensor_log1', minutes: 'custom',
    start: '2026-09-09T08:00:00+07:00', end: '2026-09-09T16:00:00+07:00', indexes: [0, 2] }
  const url = mergeParams(original, paramsFromTrend(trend), TREND_KEYS)
  assert.deepEqual(trendFromParams(url), trend)
  assert.deepEqual(url.getAll('location'), ['A', 'B'])
  assert.equal(url.get('start'), '2026-01-01')
  const relative = mergeParams(url, paramsFromTrend({ ...trend, minutes: 480 }), TREND_KEYS)
  assert.equal(relative.has('tstart'), false)
  assert.equal(relative.has('tend'), false)
  assert.equal(trendFromParams(relative).minutes, 480)
  assert.deepEqual(trendFromParams(url), trend)
})

test('relative bookmarks resolve against current time and invalid presets fall back', () => {
  const trend = trendFromParams(new URLSearchParams('win=999999'))
  assert.equal(trend.minutes, 480)
  const first = resolveTrendWindow(trend, 1_000_000_000)
  const later = resolveTrendWindow(trend, 1_000_060_000)
  assert.equal(Date.parse(later.end) - Date.parse(first.end), 60_000)
})

test('ECharts retains full bounds for empty, single and sparse series and resets zoom', () => {
  const range = resolveTrendWindow({ minutes: 480 }, Date.parse('2026-09-09T16:00:00+07:00'))
  const axis = trendTimeAxis(range)
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 320 })
  try {
    for (const data of [[], [[axis.max - 3600_000, 4]], [[axis.max - 3 * 3600_000, 4], [axis.max - 3600_000, 5]]]) {
      chart.setOption({ animation: false, xAxis: axis, yAxis: { type: 'value' },
        dataZoom: [{ type: 'inside', start: 0, end: 100 }], series: [{ type: 'line', data }] }, { notMerge: true })
      assert.deepEqual(chart.getModel().getComponent('xAxis').axis.scale.getExtent(), [axis.min, axis.max])
      assert.ok(chart.renderToSVGString().includes('<svg'))
      chart.dispatchAction({ type: 'dataZoom', start: 50, end: 100 })
    }
  } finally { chart.dispose() }
})
