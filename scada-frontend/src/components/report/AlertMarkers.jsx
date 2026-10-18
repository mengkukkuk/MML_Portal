import { useEffect, useMemo, useState } from 'react'
import CloseOutlined from '@mui/icons-material/CloseOutlined'
import { useTranslation } from '@/i18n'
import { clusterMessages, messagesBetween } from './alertFlags'
import styles from './AlertMarkers.module.css'

const SEVERITY_LABEL = { crit: 'Critical', warn: 'Warning', info: 'Info' }

// "18 Oct 14:05:09": a message is placed by its moment, and a week-long window
// needs the day as well as the time.
const moment = (t) => new Date(t).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/**
 * The alert flags along the bottom of the trend's plot, and the box a flag
 * opens.
 *
 * HTML over the chart rather than an ECharts series, for two reasons. The flags
 * are positioned by the view alone (`frac` across the plot, in CSS), so they
 * follow a pan or a pinch without the chart's option being rebuilt mid-gesture
 * — which the trend is careful never to do (useTrendViewport). And they are
 * real buttons: focusable, with an accessible name, and large enough for a
 * finger. They sit *beside* the stage, not inside it, so the stage's touch
 * handling (useTouchGestures) never swallows a tap on one.
 *
 * A pinned box is held by the time span of the flag it was opened from, not by
 * the flag: zooming re-clusters the flags, and the box keeps listing the same
 * messages and keeps its place over them until it is closed or they scroll out
 * of view.
 *
 * `plotPx` is the plot's width (for clustering only — positions are fractions),
 * `bottom` the grid's bottom margin, so the row sits on the time axis.
 */
export default function AlertMarkers({ messages, view, plotPx, bottom }) {
  const tr = useTranslation()
  const flags = useMemo(() => clusterMessages(messages, view, plotPx), [messages, view, plotPx])
  const [pinned, setPinned] = useState(null)

  useEffect(() => {
    if (!pinned) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setPinned(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned])

  const span = view.to - view.from
  const pinnedList = pinned ? messagesBetween(messages, pinned.from, pinned.to) : []
  // Shown while any of its messages are on screen, over the part that is.
  const pinnedVisible = pinnedList.length > 0 && span > 0
    && pinned.to >= view.from && pinned.from <= view.to
  const pinnedFrac = pinnedVisible
    ? ((Math.max(pinned.from, view.from) + Math.min(pinned.to, view.to)) / 2 - view.from) / span
    : null

  const label = (f) => (f.count > 1
    ? tr('{count} messages from {time}', { count: f.count, time: moment(f.from) })
    : `${tr(SEVERITY_LABEL[f.severity])} · ${moment(f.from)} · ${f.messages[0].message}`)

  return (
    <>
      <div className={styles.flags} style={{ bottom }} role="group" aria-label={tr('Alert messages')}>
        {flags.map((f) => {
          const open = pinned && pinned.from === f.from && pinned.to === f.to
          return (
            <button
              key={f.key}
              type="button"
              className={styles.flag}
              data-severity={f.severity}
              style={{ left: `${(f.frac * 100).toFixed(3)}%` }}
              aria-label={label(f)}
              aria-expanded={!!open}
              title={label(f)}
              onClick={() => setPinned(open ? null : { from: f.from, to: f.to })}
            >
              <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true">
                <path d="M1.5 1v15" className={styles.pole} />
                <path d="M2 1.5h8.5l-2.2 3 2.2 3H2z" className={styles.pennant} />
              </svg>
              {f.count > 1 && <span className={styles.count}>{f.count > 99 ? '99+' : f.count}</span>}
            </button>
          )
        })}
      </div>

      {pinnedVisible && (
        <div
          className={styles.box}
          // Kept on the card by the stylesheet, which knows the box's width.
          style={{ '--frac': pinnedFrac, bottom: `calc(${bottom}px + 28px)` }}
          role="dialog"
          aria-label={tr('Alert messages')}
        >
          <div className={styles.boxHead}>
            <span>{tr('{count} messages', { count: pinnedList.length })}</span>
            <button type="button" className={styles.close} aria-label={tr('Close')} onClick={() => setPinned(null)}>
              <CloseOutlined fontSize="inherit" />
            </button>
          </div>
          <ol className={styles.list}>
            {pinnedList.map((m, i) => (
              <li key={`${m.t}:${i}`} className={styles.item} data-severity={m.severity}>
                <span className={styles.dot} aria-hidden="true" />
                <time className={styles.time} dateTime={new Date(m.t).toISOString()}>{moment(m.t)}</time>
                <span className={styles.sev}>{m.severityRaw ?? tr(SEVERITY_LABEL[m.severity])}</span>
                <p className={styles.text}>{m.message}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  )
}
