import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inheritBinding, defaultKpiPanel, buildKpiSavePayload, draftFromPanel, panelWithDraft,
  workingHoursFrom, KPI_DEFAULTS, cleanKpi, isDefectTally,
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

test('a new block inherits the picked columns, and a Loss meter stays on defect cost', () => {
  const picked = { ...LAST, options: { kpi: { ...LAST.options.kpi, defect_cols: ['defect_array'], filter_col: 'code', filter_val: 'CAM001-13' } } }
  const b = inheritBinding([picked], 681)
  assert.deepEqual(b.kpi.defect_cols, ['defect_array'])
  assert.equal(b.kpi.filter_val, 'CAM001-13')
  const p = defaultKpiPanel('lossmeter', { binding: b, layout: { x: 0, y: 0, w: 4, h: 6 }, dashboardId: 2 })
  assert.equal(p.options.kpi.mode, 'defects')
  assert.deepEqual(p.options.kpi.defect_cols, ['defect_array'])
  assert.equal(KPI_DEFAULTS.defect_cols, null)
})

test('column picks are posted only while they are in use', () => {
  const idle = cleanKpi({ ...KPI_DEFAULTS, ts_col: 'recorded_at' })
  for (const k of ['defect_cols', 'array_mode', 'filter_col', 'filter_val']) assert.equal(k in idle, false, k)
  const used = cleanKpi({ ...KPI_DEFAULTS, defect_cols: ['defect_array'], array_mode: 'first', filter_col: 'code', filter_val: 'A' })
  assert.deepEqual([used.defect_cols, used.array_mode, used.filter_col, used.filter_val], [['defect_array'], 'first', 'code', 'A'])
  assert.equal('array_mode' in cleanKpi({ ...KPI_DEFAULTS, defect_cols: ['x'] }), false)
  const p = defaultKpiPanel('andon', { binding: { datasource_id: 1, table_name: 't', kpi: {} }, layout: {}, dashboardId: 1 })
  assert.equal('defect_cols' in p.options.kpi, false)
  const saved = buildKpiSavePayload({ id: 1, title: 'x', chart_type: 'lossmeter', options: {} }, draftFromPanel({ title: 'x', options: { kpi: {} } }))
  assert.equal('defect_cols' in saved.options.kpi, false)
})

test('blocks that need machines do not inherit a picked-columns binding', () => {
  const picked = { id: 20, source: 'kpi', datasource_id: 681, table_name: 'camera_defect', options: { kpi: {
    ts_col: 'updated_at', defect_cols: ['max_defect'], period: 'month' } } }
  const machines = { ...LAST, id: 10 }
  // the newest block is a picked Loss meter: an Andon falls back to the machine block under it
  const a = inheritBinding([machines, picked], 569, 'andon')
  assert.equal(a.table_name, 'sensor_log1')
  assert.equal(a.kpi.defect_cols, undefined)
  // with no machine block at all it starts unbound, so the inspector opens instead of the server refusing
  assert.deepEqual(inheritBinding([picked], 569, 'waterfall'), { datasource_id: 569, table_name: null, kpi: {} })
  // a Loss meter keeps the picks, and so does a caller that names no type
  assert.deepEqual(inheritBinding([machines, picked], 569, 'lossmeter').kpi.defect_cols, ['max_defect'])
  assert.equal(inheritBinding([machines, picked], 569).table_name, 'camera_defect')
})

test('an output column makes a binding every block can inherit and keeps the Loss meter off the tally', () => {
  const bound = { id: 30, source: 'kpi', datasource_id: 682, table_name: 'pressure1log', options: { kpi: {
    ts_col: 'timestamp', output_col: 'value', machine_col: 'tag_name', value_kind: 'total', defect_cols: ['setpoint'] } } }
  assert.equal(isDefectTally(bound.options.kpi), false)
  assert.equal(isDefectTally({ defect_cols: ['x'] }), true)
  const b = inheritBinding([bound], 569, 'andon')
  assert.equal(b.table_name, 'pressure1log')
  assert.deepEqual([b.kpi.output_col, b.kpi.machine_col, b.kpi.value_kind, b.kpi.defect_cols],
    ['value', 'tag_name', 'total', ['setpoint']])
})

test('output settings are posted only while an output column is in use', () => {
  const idle = cleanKpi({ ...KPI_DEFAULTS, machine_col: 'tag_name', value_kind: 'total' })
  for (const k of ['output_col', 'machine_col', 'value_kind']) assert.equal(k in idle, false, k)
  const used = cleanKpi({ ...KPI_DEFAULTS, output_col: 'value', machine_col: 'tag_name', value_kind: 'total' })
  assert.deepEqual([used.output_col, used.machine_col, used.value_kind], ['value', 'tag_name', 'total'])
  const defaults = cleanKpi({ ...KPI_DEFAULTS, output_col: 'value' })
  assert.equal('machine_col' in defaults, false)
  assert.equal('value_kind' in defaults, false)
})
