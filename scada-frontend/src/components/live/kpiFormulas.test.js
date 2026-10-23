import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPLAIN_TYPES, explainBlock, hoursText } from './kpiFormulas.js'

const THAI = /[฀-๿]/
const KPI = {
  run_ratio: 0.8, min_stop_sec: 60, max_loss_stop_min: 120, flat_min: 10, mode: 'total',
  working_hours: { start: '07:00', end: '17:30', days: [1, 2, 3, 4, 5, 6] },
  metrics: ['plan_pct', 'yield', 'availability'],
}

test('every management block type is explained', () => {
  for (const t of ['kpistrip', 'pace', 'hourly', 'sensors', 'pareto', 'response', 'andon', 'kpitrend', 'lossmeter', 'waterfall']) {
    assert.ok(EXPLAIN_TYPES.includes(t), t)
  }
  assert.equal(explainBlock('trend', KPI), null)
})

test('opens in Thai and has a complete English twin', () => {
  for (const t of EXPLAIN_TYPES) {
    const th = explainBlock(t, KPI)
    const en = explainBlock(t, KPI, 'en')
    assert.match(th.question, THAI, t)
    assert.match(th.why.text, THAI, t)
    assert.doesNotMatch(en.question + en.why.text, THAI, t)
    assert.equal(th.sections.length, en.sections.length, t)
    th.sections.forEach((sec, i) => {
      assert.ok(sec.lines.length > 0, `${t} section ${i}`)
      assert.equal(sec.lines.length, en.sections[i].lines.length, `${t} section ${i}`)
      for (const line of en.sections[i].lines) assert.doesNotMatch(line, THAI, `${t}: ${line}`)
    })
  }
})

test('equations carry the block’s own settings', () => {
  const text = explainBlock('andon', { ...KPI, run_ratio: 0.7, max_loss_stop_min: 90 }, 'en')
    .sections.flatMap((s) => s.lines).join('\n')
  assert.match(text, /70% of target/)
  assert.match(text, /≤ 90 min/)
  assert.match(text, /Mon–Sat 07:00–17:30/)
})

test('KPI strip explains only the tiles it shows; loss meter follows its mode', () => {
  const strip = explainBlock('kpistrip', { ...KPI, metrics: ['yield'] }, 'en').sections[0].lines
  assert.deepEqual(strip, ['Yield = good ÷ pieces made'])
  const meter = explainBlock('lossmeter', { ...KPI, mode: 'defects' }, 'en')
  assert.match(meter.sections[0].lines[0], /^Defect cost/)
  assert.equal(meter.sections.some((s) => s.heading === 'Counting losses'), false)
})

test('working hours read as a day range', () => {
  assert.equal(hoursText({ start: '07:00', end: '17:30', days: [1, 2, 3, 4, 5, 6] }, 'th'), 'จ–ส 07:00–17:30')
  assert.equal(hoursText({ start: '22:00', end: '06:00' }, 'en'), 'every day 22:00–06:00')
  assert.equal(hoursText({ start: '08:00', end: '17:00', days: [1, 3] }, 'en'), 'Mon, Wed 08:00–17:00')
  assert.equal(hoursText(null, 'en'), null)
})

test('a response board names its location and severity floor', () => {
  const lines = (kpi, lang) => explainBlock('response', kpi, lang).sections[0].lines.join('\n')
  assert.match(lines({ ...KPI, response_location: 'Line 13' }, 'en'), /only alerts at Line 13/)
  assert.match(lines({ ...KPI, response_location: 'Line 13' }, 'th'), /เฉพาะการแจ้งเตือนที่ Line 13/)
  assert.match(lines(KPI, 'en'), /Listed from Warning up/)
  assert.match(lines({ ...KPI, alert_min_severity: 'crit' }, 'th'), /ตั้งแต่ระดับ วิกฤต/)
})
