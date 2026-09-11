import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_INDEXES,
  DEFAULT_MINUTES,
  TREND_KEYS,
  isMultiReading,
  isPlottable,
  mergeParams,
  paramsFromTrend,
  trendFromParams,
} from './trendParams.js'

const parse = (qs) => trendFromParams(new URLSearchParams(qs))

test('a single-vcol link — every link shared before multi-select — still parses', () => {
  const trend = parse('tbl=sensor_log1&vcol=CAM001-13-defect_1&tscol=recorded_at')
  assert.deepEqual(trend.valueCols, ['CAM001-13-defect_1'])
  assert.equal(trend.table, 'sensor_log1')
  assert.equal(trend.tsCol, 'recorded_at')
  assert.equal(trend.minutes, DEFAULT_MINUTES)
  assert.deepEqual(trend.indexes, ALL_INDEXES)
})

test('repeated vcol keys parse as several readings, in link order', () => {
  const trend = parse('tbl=t&vcol=a&vcol=b&vcol=c&tscol=ts')
  assert.deepEqual(trend.valueCols, ['a', 'b', 'c'])
})

test('a trend round-trips through the query string unchanged', () => {
  const trend = parse('tbl=t&vcol=a&vcol=b&tscol=ts&win=60&idx=0,1')
  const again = trendFromParams(paramsFromTrend(trend))
  assert.deepEqual(again, trend)
})

test('the device filter is dropped from an older link rather than left hidden', () => {
  const trend = parse('tbl=t&vcol=a&tscol=ts&fcol=recorded_at&fval=CAM001-13')
  assert.equal(trend.filterCol, undefined)
  assert.equal(paramsFromTrend(trend).has('fcol'), false)
  // TREND_KEYS still owns them, which is what purges the pair from the URL.
  assert.ok(TREND_KEYS.includes('fcol') && TREND_KEYS.includes('fval'))
  const merged = mergeParams(
    new URLSearchParams('fcol=recorded_at&fval=CAM001-13&preset=last7d'),
    paramsFromTrend(trend),
    TREND_KEYS,
  )
  assert.equal(merged.has('fcol'), false)
  assert.equal(merged.get('preset'), 'last7d', 'the report filters are not this writer\'s to clear')
})

test('mergeParams keeps every reading, not just the last one', () => {
  const merged = mergeParams(
    new URLSearchParams('vcol=old&preset=last7d'),
    paramsFromTrend(parse('tbl=t&vcol=a&vcol=b&tscol=ts')),
    TREND_KEYS,
  )
  assert.deepEqual(merged.getAll('vcol'), ['a', 'b'])
})

test('a trend needs a table, a reading and a clock before it can plot', () => {
  assert.equal(isPlottable(parse('tbl=t&vcol=a&tscol=ts')), true)
  assert.equal(isPlottable(parse('tbl=t&tscol=ts')), false, 'no reading')
  assert.equal(isPlottable(parse('tbl=t&vcol=a')), false, 'no clock')
  assert.equal(isPlottable(parse('vcol=a&tscol=ts')), false, 'no table')
})

test('one reading is an envelope, two or more are a comparison', () => {
  assert.equal(isMultiReading(parse('tbl=t&vcol=a&tscol=ts')), false)
  assert.equal(isMultiReading(parse('tbl=t&vcol=a&vcol=b&tscol=ts')), true)
  assert.equal(isMultiReading(undefined), false)
})

test('role selection is untouched by the multi-reading work', () => {
  assert.deepEqual(parse('idx=none').indexes, [])
  assert.deepEqual(parse('idx=2,0').indexes, [0, 2])
  assert.deepEqual(parse('idx=9').indexes, ALL_INDEXES, 'no valid index is corrupt, not empty')
  assert.equal(paramsFromTrend(parse('tbl=t&vcol=a&tscol=ts')).has('idx'), false,
    'the common case stays a short link')
})
