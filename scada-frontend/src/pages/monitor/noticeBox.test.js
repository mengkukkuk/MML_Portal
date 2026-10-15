import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendNoticeLog, blankNotice, NOTICE_LIMIT, NOTICE_LOG_SIZE, newNoticeId, noticeIsBound,
  noticePollNodes, noticeSignature, noticeText, noticeTitle, noticeTitleField, normalizeNotices,
  readNotices,
} from './noticeBox.js'

const binding = {
  table: 'line_messages', value_col: 'message', ts_col: 'created_at', datasource_id: 3,
}
const box = (id, extra = {}) => ({
  id, label: 'แจ้งเตือน', labelEn: 'Alarms', binding, ...extra,
})

test('ids are unique across rapid successive adds', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newNoticeId()))
  assert.equal(ids.size, 50)
  assert.ok(blankNotice().id.startsWith('notice-'))
})

test('normalizeNotices: garbage in, empty list out', () => {
  assert.deepEqual(normalizeNotices(null), [])
  assert.deepEqual(normalizeNotices('x'), [])
  assert.deepEqual(normalizeNotices([null, 3, 'a', [binding]]), [])
})

test('normalizeNotices: keeps good ids, repairs duplicates and foreign ones', () => {
  const out = normalizeNotices([box('notice-a'), box('notice-a'), box('n-12'), box(undefined)])
  assert.equal(out.length, 4)
  assert.equal(out[0].id, 'notice-a')
  assert.equal(new Set(out.map((n) => n.id)).size, 4)
  out.forEach((n) => assert.ok(n.id.startsWith('notice-')))
})

test('normalizeNotices: upgrades the single legacy notice, caps the list', () => {
  const legacy = normalizeNotices(undefined, { id: '__notice', labelEn: 'Line', binding })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].labelEn, 'Line')
  assert.equal(legacy[0].binding, binding)
  // A real list wins over the legacy field.
  assert.deepEqual(normalizeNotices([], { binding }), [])
  const many = Array.from({ length: 10 }, (_, i) => box(`notice-${i}`))
  assert.equal(normalizeNotices(many).length, NOTICE_LIMIT)
})

test('readNotices is pure: drops what it cannot read, never mints', () => {
  const list = [box('notice-a'), box('notice-a'), box(''), { label: 'x' }, box('notice-b')]
  assert.deepEqual(readNotices(list).map((n) => n.id), ['notice-a', 'notice-b'])
  assert.deepEqual(readNotices(list), readNotices(list))
  assert.deepEqual(readNotices(null), [])
})

test('only bound boxes are polled', () => {
  assert.equal(noticeIsBound(blankNotice()), false)
  assert.deepEqual(noticePollNodes([blankNotice()]), [])
  assert.deepEqual(noticePollNodes(null), [])
  const nodes = noticePollNodes([blankNotice(), box('notice-a')])
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].id, 'notice-a')
  assert.equal(nodes[0].binding, binding)
})

test('signature changes with the stream, not the title', () => {
  const a = noticeSignature(box('notice-a'))
  assert.equal(a, noticeSignature(box('notice-a', { label: 'other' })))
  assert.notEqual(a, noticeSignature({ binding: { ...binding, filter_val: 'L2' } }))
  assert.equal(noticeSignature(null), '')
})

test('title follows the language, falling back to the other one', () => {
  assert.equal(noticeTitle(box('notice-a'), 'th'), 'แจ้งเตือน')
  assert.equal(noticeTitle(box('notice-a'), 'en'), 'Alarms')
  assert.equal(noticeTitle(box('notice-a', { labelEn: '' }), 'en'), 'แจ้งเตือน')
  assert.equal(noticeTitle(null, 'en'), '')
  assert.equal(noticeTitleField('th'), 'label')
  assert.equal(noticeTitleField('en'), 'labelEn')
})

test('noticeText prints text as written and numbers formatted', () => {
  assert.equal(noticeText(null), '')
  assert.equal(noticeText({ value: null, display: null, state: null }), '')
  assert.equal(noticeText({ value: 'QC hold on lot 4471', state: 'QC hold on lot 4471' }), 'QC hold on lot 4471')
  assert.equal(noticeText({ value: 12, display: 12, decimals: 0 }), '12')
})

test('appendNoticeLog: newest first, same row twice is one message', () => {
  let log = []
  log = appendNoticeLog(log, { text: 'A', ts: 1 })
  log = appendNoticeLog(log, { text: 'A', ts: 1 })
  assert.equal(log.length, 1)
  log = appendNoticeLog(log, { text: 'B', ts: 2 })
  log = appendNoticeLog(log, { text: 'B', ts: 3 })
  assert.deepEqual(log.map((e) => e.ts), [3, 2, 1])
})

test('appendNoticeLog: ignores empty text and caps the length', () => {
  let log = appendNoticeLog([], { text: '', ts: 1 })
  assert.deepEqual(log, [])
  for (let i = 0; i < 10; i += 1) log = appendNoticeLog(log, { text: `m${i}`, ts: i })
  assert.equal(log.length, NOTICE_LOG_SIZE)
  assert.equal(log[0].text, 'm9')
})
