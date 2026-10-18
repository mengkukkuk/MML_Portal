import { useEffect, useState } from 'react'
import CloseOutlined from '@mui/icons-material/CloseOutlined'
import PanToolOutlined from '@mui/icons-material/PanToolOutlined'
import ZoomInOutlined from '@mui/icons-material/ZoomInOutlined'
import ZoomOutOutlined from '@mui/icons-material/ZoomOutOutlined'
import ZoomOutMapOutlined from '@mui/icons-material/ZoomOutMapOutlined'
import { useTranslation } from '@/i18n'
import { spanLabel } from './trendDetail'
import styles from './TrendToolbar.module.css'

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

// 100% is the whole window. Past a thousand the figure outgrows its slot, and "x33" says the same thing.
const zoomLabel = (percent) => (percent >= 1000 ? `×${Math.round(percent / 100)}` : `${percent}%`)

/**
 * TrendToolbar — the signal trend's view controls and its live state, as one
 * instrument cluster above the chart: hand, zoom out / in with the reading
 * between them, fit, and the Live switch with the time of the last read.
 *
 * Same family as the Monitor's view controls (hand, zoom, fit) so the two pages
 * answer the same gestures the same way. `viewport` is `useTrendViewport`'s
 * result; `live` carries the refresh state: `{ on, canFollow, every, updatedAt,
 * onToggle }`.
 *
 * The lamp is the one animated thing, and it animates only when something
 * happened: it flashes once each time a read lands, so a stalled feed looks
 * stalled instead of looking busy. Under reduced motion it simply does not.
 */
export default function TrendToolbar({ viewport, live }) {
  const tr = useTranslation()
  const { hand, percent, span } = viewport

  const liveTitle = !live.canFollow
    ? tr('A fixed window does not change. Choose a relative window to follow live data.')
    : live.on
      ? tr('Refreshing every {interval} — the global interval from Settings. Click to pause.', { interval: live.every })
      : tr('Paused. Click to refresh every {interval}.', { interval: live.every })

  return (
    <div className={`${styles.bar} report-controls`} role="group" aria-label={tr('Chart view')}>
      {/* Mouse and pen only — a finger always pans — so a touch screen hides it
          (TrendToolbar.module.css). */}
      <button
        type="button"
        className={`${styles.tool} ${styles.handTool} ${hand ? styles.toolOn : ''}`}
        aria-pressed={hand}
        title={tr('Hand tool: drag the chart to move along time. Off: drag a box to zoom into it.')}
        onClick={() => viewport.setHand(!hand)}
      >
        <PanToolOutlined fontSize="small" />
        <span className={styles.toolLabel}>{tr('Hand')}</span>
      </button>

      <span className={`${styles.divider} ${styles.handTool}`} aria-hidden="true" />

      <button
        type="button"
        className={styles.tool}
        title={tr('Zoom out')}
        aria-label={tr('Zoom out')}
        disabled={!viewport.canZoomOut}
        onClick={viewport.zoomOut}
      >
        <ZoomOutOutlined fontSize="small" />
      </button>
      {/* The span on screen is the zoom level: "1 h" says what is being read,
          "×156" only how far from the window it is — kept for the tooltip. */}
      <output className={styles.zoom} aria-label={tr('Chart zoom')} title={zoomLabel(percent)}>
        {spanLabel(span)}
      </output>
      <button
        type="button"
        className={styles.tool}
        title={tr('Zoom in')}
        aria-label={tr('Zoom in')}
        disabled={!viewport.canZoomIn}
        onClick={viewport.zoomIn}
      >
        <ZoomInOutlined fontSize="small" />
      </button>
      <button
        type="button"
        className={styles.tool}
        title={tr('Show the whole window')}
        aria-label={tr('Show the whole window')}
        disabled={!viewport.canZoomOut}
        onClick={viewport.reset}
      >
        <ZoomOutMapOutlined fontSize="small" />
      </button>

      <span className={styles.divider} aria-hidden="true" />

      <button
        type="button"
        className={`${styles.tool} ${live.on && live.canFollow ? styles.liveOn : ''}`}
        aria-pressed={live.on && live.canFollow}
        disabled={!live.canFollow}
        title={liveTitle}
        onClick={live.onToggle}
      >
        {/* Re-keyed on every read so the flash restarts; see the note above. */}
        <span
          key={live.updatedAt}
          className={`${styles.lamp} ${live.on && live.canFollow ? styles.lampBeat : ''}`}
          aria-hidden="true"
        />
        <span className={styles.toolLabel}>{tr('Live')}</span>
        {live.canFollow && <span className={styles.every}>{live.every}</span>}
      </button>
      {!!live.updatedAt && (
        <time
          className={styles.stamp}
          dateTime={new Date(live.updatedAt).toISOString()}
          title={tr('Updated {time}', { time: clock(live.updatedAt) })}
        >
          {clock(live.updatedAt)}
        </time>
      )}
    </div>
  )
}

// A phone or tablet: no hover, and a finger for a pointer. A touch laptop has a
// trackpad too and keeps the mouse toolbar — the gestures work there per event.
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)'
const HINT_KEY = 'trend.touchHint.dismissed'

function readDismissed() {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

function useTouchScreen() {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(TOUCH_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(TOUCH_QUERY)
    if (!mq) return undefined
    const onChange = () => setTouch(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return touch
}

/**
 * The gestures, said once. Pinch and hold are invisible until someone tells you,
 * so a touch screen gets one line under the toolbar until it is dismissed —
 * remembered per device, and harmless if the browser will not remember it.
 */
export function TrendTouchHint() {
  const tr = useTranslation()
  const touch = useTouchScreen()
  const [dismissed, setDismissed] = useState(readDismissed)
  if (!touch || dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(HINT_KEY, '1')
    } catch { /* shown again next visit, nothing worse */ }
  }

  return (
    <p className={styles.hint}>
      <span>{tr('Hold to read · pinch to zoom')}</span>
      <button type="button" className={styles.hintClose} aria-label={tr('Dismiss')} onClick={dismiss}>
        <CloseOutlined fontSize="inherit" />
      </button>
    </p>
  )
}
