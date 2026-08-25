import { useEffect, useRef, useState } from 'react'
import styles from './ConnectionAlarmStrip.module.css'

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * ConnectionAlarmStrip — an annunciator, not a toast.
 *
 * Live and Monitor are the operational screens: an operator's eye has to
 * catch a dead plant connection without reading a sentence. Every fanned-out
 * endpoint already reports one entry per selected source with `ok`/`error`
 * (see CLAUDE.md's app/config-vs-plant split) — this renders the failed ones
 * as individual tiles, each carrying its own name and how long it has been
 * down, the way a real alarm summary shows "time in alarm" rather than one
 * collapsed sentence that hides how many, which, and for how long.
 *
 * Renders nothing while every source answers, so it costs a normal shift no
 * screen space. Distinct on purpose from SourceStatus (used on the
 * historical/report pages): those are reviewed after the fact, this is
 * watched continuously, so it earns a heavier, instrument-like treatment.
 */
export default function ConnectionAlarmStrip({ sources = [] }) {
  const failed = sources.filter((s) => !s.ok)
  const failedKey = failed.map((s) => s.datasource_id ?? 'app').join(',')

  // First-seen-down per source, so each tile can show how long it has been
  // out rather than just that it currently is. Cleared the moment a source
  // stops appearing in the failed set — a recovery costs the tile, not a
  // restart of the timer next time it (maybe) fails again.
  const sinceRef = useRef(new Map())
  useEffect(() => {
    const now = Date.now()
    const seen = new Set(failedKey ? failedKey.split(',') : [])
    seen.forEach((id) => {
      if (!sinceRef.current.has(id)) sinceRef.current.set(id, now)
    })
    Array.from(sinceRef.current.keys()).forEach((id) => {
      if (!seen.has(id)) sinceRef.current.delete(id)
    })
  }, [failedKey])

  // Only ticks while something is actually down — a healthy shift pays no
  // timer at all.
  const [, retick] = useState(0)
  useEffect(() => {
    if (!failed.length) return undefined
    const id = setInterval(() => retick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [failed.length])

  if (!failed.length) return null

  const now = Date.now()
  return (
    <div className={styles.strip} role="alert" aria-label="Data source connection alarms">
      <span className={styles.eyebrow}>Connection lost</span>
      <div className={styles.tiles}>
        {failed.map((s) => {
          const id = String(s.datasource_id ?? 'app')
          const since = sinceRef.current.get(id) ?? now
          return (
            <div key={id} className={styles.tile} title={s.error || 'No connection'}>
              <span className={styles.bar} aria-hidden="true" />
              <span className={styles.name}>{s.datasource_name || `Source ${id}`}</span>
              <span className={styles.elapsed}>{formatElapsed(now - since)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
