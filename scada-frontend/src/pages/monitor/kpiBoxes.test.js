import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blankKpi, KPI_LIMIT, kpiIsBound, kpiPollNodes, newKpiId, normalizeKpis, readKpis,
} from './kpiBoxes.js'


const bound = (id, valueCol = 'good_count') => ({
  id,
  label: 'ผลิตได้วันนี้',
  labelEn: 'Produced today',
  binding: { table: 'sensor_readings', value_col: valueCol, decimals: 0 },
})


test('ids are unique across rapid successive adds', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newKpiId()))
  assert.equal(ids.size, 50)
})


test('a fresh box is unbound, so it asks the plant for nothing', () => {
  const kpi = blankKpi()
  assert.equal(kpiIsBound(kpi), false)
  assert.deepEqual(kpiPollNodes([kpi]), [])
})


test('a box counts as bound only with both a table and a value column', () => {
  assert.equal(kpiIsBound({ binding: { table: 't', value_col: 'v' } }), true)
  assert.equal(kpiIsBound({ binding: { table: 't' } }), false)
  assert.equal(kpiIsBound({ binding: { value_col: 'v' } }), false)
  assert.equal(kpiIsBound(null), false)
})


test('normalize keeps good documents byte-for-byte, including box order', () => {
  const stored = [bound('kpi-a'), bound('kpi-b', 'reject_count')]
  const out = normalizeKpis(stored)
  assert.deepEqual(out.map((k) => k.id), ['kpi-a', 'kpi-b'])
  assert.equal(out[1].binding.value_col, 'reject_count')
})


test('duplicate ids are re-issued, so two boxes can never share one reading', () => {
  const out = normalizeKpis([bound('kpi-a'), bound('kpi-a', 'reject_count')])
  assert.notEqual(out[0].id, out[1].id)
  assert.equal(out[0].id, 'kpi-a')
  // The binding rides through untouched — only the colliding id is repaired.
  assert.equal(out[1].binding.value_col, 'reject_count')
})


test('a box with no id at all is given one rather than dropped', () => {
  const out = normalizeKpis([{ label: 'x', binding: { table: 't', value_col: 'v' } }])
  assert.equal(out.length, 1)
  assert.match(out[0].id, /^kpi-/)
})


test('a document that is not a list yields an empty strip, never a throw', () => {
  assert.deepEqual(normalizeKpis(undefined), [])
  assert.deepEqual(normalizeKpis(null), [])
  assert.deepEqual(normalizeKpis({ 0: bound('kpi-a') }), [])
})


test('junk entries are discarded without taking the strip down with them', () => {
  const out = normalizeKpis([null, bound('kpi-a'), 'nope', 7])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'kpi-a')
})


test('the strip is capped so a wall display stays readable', () => {
  const many = Array.from({ length: KPI_LIMIT + 4 }, (_, i) => bound(`kpi-${i}`))
  assert.equal(normalizeKpis(many).length, KPI_LIMIT)
})


test('poll nodes carry the binding through unchanged and skip unbound boxes', () => {
  const kpis = [bound('kpi-a'), blankKpi(), bound('kpi-b', 'reject_count')]
  const nodes = kpiPollNodes(kpis)
  assert.deepEqual(nodes.map((n) => n.id), ['kpi-a', 'kpi-b'])
  // Same object the poller's argsOf reads — no remapping between doc and poll.
  assert.equal(nodes[0].binding, kpis[0].binding)
})


test('an unlabelled box still polls under a printable label', () => {
  const nodes = kpiPollNodes([{ id: 'kpi-a', label: '', binding: { table: 't', value_col: 'v' } }])
  assert.equal(nodes[0].label, 'kpi-a')
})


/* --- readKpis: the render path, which must never mint ------------------- */

test('reading the same document twice yields identical ids', () => {
  // The regression that matters: `kpis` is recomputed whenever the layout
  // object changes identity, which is every single edit. If reading could mint
  // an id, an otherwise-valid document would move the poller's query key on
  // every nudge of an unrelated symbol and throw that box's history away.
  const doc = [bound('kpi-a'), bound('kpi-b', 'reject_count')]
  assert.deepEqual(readKpis(doc).map((k) => k.id), readKpis(doc).map((k) => k.id))
})

test('reading is deterministic even for a malformed document', () => {
  const doc = [{ label: 'no id', binding: { table: 't', value_col: 'v' } }, bound('kpi-a')]
  const first = readKpis(doc)
  const second = readKpis(doc)
  assert.deepEqual(first, second)
  // Dropped rather than given an id: minting belongs to migrateLayout, which
  // writes its repair back into the document.
  assert.deepEqual(first.map((k) => k.id), ['kpi-a'])
})

test('reading keeps the first of two boxes sharing an id, never both', () => {
  const out = readKpis([bound('kpi-a'), bound('kpi-a', 'reject_count')])
  assert.equal(out.length, 1)
  assert.equal(out[0].binding.value_col, 'good_count')
})

test('reading agrees with normalize on any document normalize produced', () => {
  // migrateLayout runs normalizeKpis, so this is the only pairing that happens
  // in practice — the two must not disagree about a repaired document.
  const repaired = normalizeKpis([{ label: 'x', binding: { table: 't', value_col: 'v' } }, bound('kpi-a')])
  assert.deepEqual(readKpis(repaired), repaired)
})

test('reading caps and survives junk the same way normalize does', () => {
  assert.deepEqual(readKpis(null), [])
  assert.deepEqual(readKpis([null, 7, 'nope']), [])
  const many = Array.from({ length: KPI_LIMIT + 4 }, (_, i) => bound(`kpi-${i}`))
  assert.equal(readKpis(many).length, KPI_LIMIT)
})
