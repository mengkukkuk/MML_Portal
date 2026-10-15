import { useEffect, useRef, useState } from 'react'
import { formatValue } from '@/components/mimic/tagStatus'
import { fmtStamp } from '@/utils/datetime'
import { useLanguageStore, useTranslation } from '@/i18n'
import {
  NOTICE_LIMIT, noticeIsBound, noticeText, noticeTitle, noticeTitleField,
} from '../noticeBox'
import styles from '../MonitorPage.module.css'

/**
 * Which view the strip opens on. A viewing preference, so it is per viewer and
 * per browser (localStorage), like the overview fold — never in the document,
 * where one operator's choice would become every wall display's.
 */
const MODE_KEY = 'monitor.attentionMode'

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'handle' ? 'handle' : 'notice'
  } catch {
    return 'notice'
  }
}

function writeMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch { /* private mode — the choice lasts for this visit only */ }
}

/**
 * The attention strip under the sheet, in two views.
 *
 * การแจ้งเตือน (Notification, the default) — message boxes, one row each: a
 * title, then the newest row of a bound text column from the plant's own data.
 * Added, titled and commissioned in edit mode from the strip itself, see
 * noticeBox.js.
 *
 * สิ่งที่ต้องจัดการ (Things to handle) — every symbol on the sheet, the ones
 * needing a person first: alarm, then off-normal, then not connected, then the
 * healthy rest. Clicking an entry selects the symbol on the drawing.
 * `attention` comes from `rankAttention` (monitorStatus.js).
 *
 * While the notification is showing, the Things-to-handle button carries the
 * alarm count, so choosing the message view can never hide an alarm.
 */
export default function AttentionStrip({
  attention, selectedId, onSelect,
  notices = [], tags = {}, noticeLogs = {}, editing = false,
  onAddNotice, onEditNotice, onRenameNotice,
}) {
  const tr = useTranslation()
  const [mode, setMode] = useState(readMode)
  const choose = (next) => {
    setMode(next)
    writeMode(next)
  }

  const alarms = attention.crit + attention.warn

  return (
    <section className={styles.strip} aria-label={tr('Attention view')}>
      <div className={styles.stripHead}>
        <div className={styles.modeToggle} role="group" aria-label={tr('Attention view')}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'notice' ? styles.modeBtnOn : ''}`}
            aria-pressed={mode === 'notice'}
            onClick={() => choose('notice')}
          >
            {tr('Notification')}
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'handle' ? styles.modeBtnOn : ''}`}
            aria-pressed={mode === 'handle'}
            onClick={() => choose('handle')}
          >
            {tr('Things to handle')}
            {mode === 'notice' && alarms > 0 && (
              <span className={`${styles.modeBadge} ${attention.crit ? styles.modeBadgeCrit : styles.modeBadgeWarn}`}>
                {alarms}
              </span>
            )}
          </button>
        </div>
        {mode === 'handle' ? (
          <span className={styles.stripCounts}>
            {attention.crit > 0 && <span className={styles.countCrit}>{tr('{count} alarm', { count: attention.crit })}</span>}
            {attention.warn > 0 && <span className={styles.countWarn}>{tr('{count} off normal', { count: attention.warn })}</span>}
            {attention.unbound > 0 && <span className={styles.countUnbound}>{tr('{count} not connected', { count: attention.unbound })}</span>}
            {!attention.crit && !attention.warn && !attention.unbound && (
              <span className={styles.countOk}>{tr('Nothing needs attention')}</span>
            )}
          </span>
        ) : null}
      </div>

      {mode === 'handle' ? (
        <div className={styles.stripItems} role="group" aria-label={tr('All plant tags')}>
          {attention.ordered.map(({ node, tag, rank }) => {
            const on = selectedId === node.id
            const tone = rank === 0 ? styles.chipCrit : rank === 1 ? styles.chipWarn : ''
            return (
              <button
                key={node.id}
                type="button"
                className={`${styles.chip} ${on ? styles.chipOn : ''} ${tone} ${tag ? '' : styles.chipUnbound}`}
                aria-pressed={on}
                onClick={() => onSelect(node.id)}
              >
                <span className={styles.chipId}>{node.tagId || node.label}</span>
                <span className={styles.chipValue}>{tag ? formatValue(tag) : '—'}</span>
                {tag?.unit && <span className={styles.chipUnit}>{tag.unit}</span>}
              </button>
            )
          })}
        </div>
      ) : (
        <NoticeList
          notices={notices}
          tags={tags}
          logs={noticeLogs}
          editing={editing}
          onAdd={onAddNotice}
          onEdit={onEditNotice}
          onRename={onRenameNotice}
        />
      )}
    </section>
  )
}

/**
 * The message boxes, one row each: title, then the newest message.
 *
 * The message comes from the tag, not the log, so it is on screen from the
 * first poll. There is no time column and no "stale" marking: a message is
 * meant to stand until the next one is written, and when the time matters the
 * message usually carries it. The few messages before the current one are in
 * the row's tooltip, with their times. A source that stopped answering is the
 * connection strip's to report, above the sheet.
 */
function NoticeList({
  notices, tags, logs, editing, onAdd, onEdit, onRename,
}) {
  const tr = useTranslation()
  const language = useLanguageStore((s) => s.language)

  if (!notices.length && !editing) {
    return <div className={styles.notice}><span className={styles.noticeEmpty}>{tr('No message boxes yet')}</span></div>
  }

  return (
    <div className={styles.notice}>
      <div className={`${styles.noticeGrid} ${editing ? styles.noticeGridEdit : ''}`}>
        {notices.map((notice) => {
          const title = noticeTitle(notice, language)
          const tag = tags[notice.id]
          const text = noticeText(tag)
          const bound = noticeIsBound(notice)
          const earlier = (logs[notice.id] ?? [])
            .filter((e) => !(e.text === text && e.ts === (tag?.ts ?? null)))
          const tooltip = earlier.length
            ? [`${tr('Earlier')}:`, ...earlier.map((e) => `${fmtStamp(e.ts)}  ${e.text}`)].join('\n')
            : undefined
          return (
            <div key={notice.id} className={styles.noticeRow}>
              {editing ? (
                <TitleInput
                  value={notice[noticeTitleField(language)]}
                  placeholder={title || tr('Title')}
                  label={tr('Title')}
                  onCommit={(next) => onRename(notice.id, { [noticeTitleField(language)]: next })}
                />
              ) : (
                <span className={styles.noticeTitle}>{title || tr('Untitled')}</span>
              )}
              <span
                className={`${styles.noticeText} ${bound && text ? '' : styles.noticeTextEmpty}`}
                role="status"
                aria-live="polite"
                aria-label={title || undefined}
                title={tooltip}
              >
                {!bound ? tr('No message source connected') : text || '—'}
              </span>
              {editing && (
                <button
                  type="button"
                  className={styles.noticeEdit}
                  aria-label={`${tr('Message source…')} ${title}`}
                  onClick={() => onEdit(notice)}
                >
                  {tr('Message source…')}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {editing && notices.length < NOTICE_LIMIT && (
        <button type="button" className={styles.noticeAdd} onClick={onAdd}>
          {tr('+ Add message box')}
        </button>
      )}
    </div>
  )
}

/**
 * The title, typed in place. Committed on blur or Enter rather than per
 * keystroke, so one rename is one undo step; Escape puts the old title back.
 */
function TitleInput({ value, placeholder, label, onCommit }) {
  const [draft, setDraft] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => { setDraft(value) }, [value])

  return (
    <input
      className={styles.noticeTitleInput}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false
          setDraft(value)
          return
        }
        const next = draft.trim()
        if (next !== value) onCommit(next)
      }}
    />
  )
}
