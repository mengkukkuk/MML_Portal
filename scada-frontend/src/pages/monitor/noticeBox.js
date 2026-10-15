/**
 * noticeBox — the message boxes in the attention strip.
 *
 * Where the KPI strip prints headline numbers, each box here prints one
 * *sentence* under a title of its own: the newest row of a message column
 * ("เปลี่ยนแม่พิมพ์ไลน์ 2", "QC hold on lot 4471"). They are bound and polled
 * exactly like KPI boxes — a flat snake_case binding stored on the layout
 * document, joined to the one poll round as pseudo-nodes — so they inherit the
 * cadence control, the stale rule and source health without a clock of their
 * own. See kpiBoxes.js for why the binding keeps the poller's own shape, and
 * why ids are minted at the document boundary only.
 *
 * Text readings need nothing new downstream: `deriveTag` already carries a
 * string reading into `tag.value`/`tag.state`, and `tag.ts` is the row's own
 * timestamp whenever the binding names a timestamp column (which the dialog
 * requires).
 */
import { formatValue } from '../../components/mimic/tagStatus.js'

/** Enough for a few streams (alarms, QC, maintenance) without burying the sheet. */
export const NOTICE_LIMIT = 6

/** How many messages a box remembers, the current one included. */
export const NOTICE_LOG_SIZE = 5

/** Prefix, base36 clock, counter — the repo's id convention (see newKpiId). */
let addCounter = 0
export function newNoticeId() {
  addCounter += 1
  return `notice-${Date.now().toString(36)}-${addCounter}`
}

/** A box with nothing bound yet — added by "+ Add message box", configured after. */
export function blankNotice() {
  return { id: newNoticeId(), label: '', labelEn: '', binding: null }
}

/** The fields a box is allowed to carry, and nothing else. */
function cleanNotice(raw, id) {
  return {
    id,
    label: typeof raw.label === 'string' ? raw.label : '',
    labelEn: typeof raw.labelEn === 'string' ? raw.labelEn : '',
    binding: raw.binding && typeof raw.binding === 'object' && !Array.isArray(raw.binding)
      ? raw.binding
      : null,
  }
}

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * Whatever the document held, repaired into a list this build can render.
 *
 * Accepts the single `notice` an earlier build of this feature wrote and turns
 * it into a one-box list. **Mints ids, so it belongs in `migrateLayout` and
 * nowhere else** — the same rule, for the same reason, as `normalizeKpis`.
 */
export function normalizeNotices(list, legacy = null) {
  const source = Array.isArray(list) ? list : isObject(legacy) ? [legacy] : []
  const seen = new Set()
  return source
    .filter(isObject)
    .slice(0, NOTICE_LIMIT)
    .map((raw) => {
      const id = typeof raw.id === 'string' && raw.id.startsWith('notice-') && !seen.has(raw.id)
        ? raw.id
        : newNoticeId()
      seen.add(id)
      return cleanNotice(raw, id)
    })
}

/**
 * The same list, read rather than repaired — pure, and safe on every render.
 * A box with no usable id is dropped instead of being given one.
 */
export function readNotices(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  list.forEach((raw) => {
    if (!isObject(raw)) return
    const { id } = raw
    if (typeof id !== 'string' || !id || seen.has(id)) return
    seen.add(id)
    if (out.length < NOTICE_LIMIT) out.push(cleanNotice(raw, id))
  })
  return out
}

/** True once the box points at something the poller can read. */
export function noticeIsBound(notice) {
  return !!(notice?.binding?.table && notice?.binding?.value_col)
}

/**
 * The bound boxes dressed as nodes for the plant poller. Unbound ones are left
 * out for the same reason `kpiPollNodes` drops them: an empty binding must never
 * count towards "every binding came back empty".
 */
export function noticePollNodes(notices) {
  return (notices ?? [])
    .filter(noticeIsBound)
    .map((n) => ({ id: n.id, label: n.label || n.labelEn || n.id, binding: n.binding }))
}

/**
 * The parts of a binding that make it a *different* message stream. When they
 * change, the remembered log belongs to the old column and is dropped.
 */
export function noticeSignature(notice) {
  const b = notice?.binding
  if (!b) return ''
  return [b.datasource_id, b.table, b.value_col, b.ts_col, b.filter_col, b.filter_val].join('\u0001')
}

/**
 * The box's title in the reader's language, falling back to the other one.
 * Which field an inline edit writes is `noticeTitleField`'s to say.
 */
export function noticeTitle(notice, language) {
  if (!notice) return ''
  return language === 'th'
    ? notice.label || notice.labelEn
    : notice.labelEn || notice.label
}

/** The title field an inline edit in this language writes. */
export function noticeTitleField(language) {
  return language === 'th' ? 'label' : 'labelEn'
}

/**
 * The message as printed: a text column as written, a number formatted, and
 * '' when there is no reading yet — never formatValue's em-dash, which would
 * otherwise be logged as if the line had said "—".
 */
export function noticeText(tag) {
  if (!tag || tag.value == null) return ''
  if (typeof tag.value === 'string') return tag.value
  return formatValue(tag)
}

/**
 * The log with one more reading, newest first.
 *
 * A poll that returns the same row again (same text, same timestamp) is not a
 * new message and is dropped — a 5s cadence would otherwise fill the log with
 * one sentence. The same text at a *new* time is kept: "door open" twice in an
 * hour is two events.
 */
export function appendNoticeLog(log, entry, limit = NOTICE_LOG_SIZE) {
  if (!entry || !entry.text) return log
  const head = log[0]
  if (head && head.text === entry.text && head.ts === entry.ts) return log
  return [entry, ...log].slice(0, limit)
}
