import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultProductionHour, formatRejectRate, PRODUCTION_LOG_COPY,
  productionBarHeight, productionHourIsFuture, rejectRate,
} from './productionLog.js'


test('current shift hour is selected and outside-shift times clamp to the nearest edge', () => {
  assert.equal(defaultProductionHour({ generated_at: '2026-08-28T13:15:00+07:00', current_hour: 13 }), 13)
  assert.equal(defaultProductionHour({ generated_at: '2026-08-28T06:00:00+07:00', current_hour: null }), 8)
  assert.equal(defaultProductionHour({ generated_at: '2026-08-28T20:00:00+07:00', current_hour: null }), 17)
})


test('reject rate uses good plus rejected as the denominator', () => {
  assert.equal(rejectRate(183, 6), 3.17)
  assert.equal(rejectRate(0, 0), 0)
})


test('displayed reject rates always include two decimal places', () => {
  assert.equal(formatRejectRate({ produced: 183, rejected: 6, reject_rate: 3.17 }), '3.17%')
  assert.equal(formatRejectRate({ produced: 0, rejected: 0 }), '0.00%')
})


test('operator-facing production labels remain Thai-first and bilingual', () => {
  for (const labels of Object.values(PRODUCTION_LOG_COPY)) {
    assert.match(labels[0], /[\u0E00-\u0E7F]/)
    assert.match(labels[1], /[A-Za-z]/)
  }
})


test('bar heights preserve a visible minimum without inventing an empty bar', () => {
  assert.equal(productionBarHeight(0, 183), 0)
  assert.equal(productionBarHeight(1, 183), 4)
  assert.equal(productionBarHeight(183, 183), 100)
})


test('future-hour styling follows the plant timestamp rather than browser time', () => {
  const log = { generated_at: '2026-08-28T07:30:00+07:00' }
  assert.equal(productionHourIsFuture(log, 8), true)
  assert.equal(productionHourIsFuture({ generated_at: '2026-08-28T18:01:00+07:00' }, 17), false)
})
