import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inheritBinding, defaultKpiPanel, buildKpiSavePayload, draftFromPanel, panelWithDraft,
  workingHoursFrom, KPI_DEFAULTS,
} from './kpiPayload.js'

const LAST = {
  id: 12, source: 'kpi', datasource_id: 850, table_name: 'sensor_log1',
  options: { kpi: { ts_col: 'recorded_at', cost_per_piece: 12, slots: { speed: 'count_1', defects: 'defect_*' },
    targets: { 'CAM002-13': 7500 }, period: 'week', mode: 'lost' } },
}

test('a new block inherits the newest block binding on the dashboard', () => {
  const b = inheritBinding([{ id: 3, source: 'table', table_name: 'x' }, { ...LAST, id: 4, table_name: 'old' }, LAST], 569)
  assert.equal(b.table_name, 'sensor_log1')
  assert.equal(b.datasource_id, 850)
  assert.equal(b.kpi.cost_per_piece, 12)
  // the same loss rules, so blocks on one board can't disagree
  assert.deepEqual(b.kpi.targets, { 'CAM002-13': 7500 })
  assert.equal(b.kpi.period, 'week')
  assert.equal(b.kpi.mode, undefined)
  b.kpi.targets['CAM002-13'] = 1
  assert.equal(LAST.options.kpi.targets['CAM002-13'], 7500)
})

test('with no block yet, it starts unbound on the primary datasource', () => {
  assert.deepEqual(inheritBinding([], 569), { datasource_id: 569, table_name: null, kpi: {} })
})

test('default panel is a complete kpi create payload', () => {
  const p = defaultKpiPanel('andon', {
    binding: inheritBinding([LAST]), layout: { x: 0, y: 3, w: 8, h: 7 }, dashboardId: 2, position: 4,
  })
  assert.equal(p.source, 'kpi')
  assert.equal(p.chart_type, 'andon')
  assert.equal(p.poll_interval_seconds, 60)
  assert.equal(p.ts_col, 'recorded_at')
  assert.equal(p.options.kpi.period, 'week') // inherited from the board's newest block
  assert.equal(p.options.kpi.cost_per_piece, 12)
  assert.deepEqual(p.options.layout, { x: 0, y: 3, w: 8, h: 7 })
})

test('save payload keeps layout and applies the draft', () => {
  const panel = { ...LAST, chart_type: 'lossmeter', title: 'A', dashboard_id: 2, position: 1,
    poll_interval_seconds: 30, options: { ...LAST.options, layout: { x: 1, y: 2, w: 3, h: 4 } } }
  const draft = draftFromPanel(panel)
  draft.kpi.mode = 'lost'
  draft.title = '  Lost today '
  const out = buildKpiSavePayload(panel, draft)
  assert.equal(out.title, 'Lost today')
  assert.equal(out.options.kpi.mode, 'lost')
  assert.deepEqual(out.options.layout, { x: 1, y: 2, w: 3, h: 4 })
  assert.equal(out.poll_interval_seconds, 30)
  assert.equal(draftFromPanel({ options: {} }).kpi.max_loss_stop_min, KPI_DEFAULTS.max_loss_stop_min)
})

test('the tile previews the draft', () => {
  const draft = draftFromPanel(LAST)
  draft.table_name = 'zz_kpi_demo'
  assert.equal(panelWithDraft(LAST, draft).table_name, 'zz_kpi_demo')
  assert.equal(panelWithDraft(LAST, null), LAST)
})

test('working hours need two valid, different clocks and a day', () => {
  assert.deepEqual(workingHoursFrom('07:00', '17:00', [3, 1, 1]), { start: '07:00', end: '17:00', days: [1, 3] })
  assert.equal(workingHoursFrom('7:00', '17:00', [1]), null)
  assert.equal(workingHoursFrom('07:00', '07:00', [1]), null)
  assert.equal(workingHoursFrom('07:00', '17:00', []), null)
})
