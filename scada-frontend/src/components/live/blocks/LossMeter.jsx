import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import {
  lossMeterFigures, lossDelta, appendSpark, fmtBaht, fmtPieces,
} from '../kpiView'
import styles from './Blocks.module.css'

/**
 * LossMeter — one big number: what defects, lost production, or both have
 * cost this period. ฿ when the viewer may see cost (the server decides, see
 * kpi.py), pieces otherwise. A stop still in progress shows as "pending" rather
 * than being added and later taken back; the change line compares like-for-like
 * against the same elapsed time of the previous period.
 *
 * The faint line behind the number is the running total over this session's
 * polls — built client-side, because the summary carries totals only.
 */
export default function LossMeter({ summary, mode = 'defects' }) {
  const tr = useTranslation()
  const f = useMemo(() => lossMeterFigures(summary, mode), [summary, mode])
  const showBaht = f?.baht != null

  const [spark, setSpark] = useState([])
  const value = showBaht ? f?.baht : f?.pieces
  const at = summary?.generated_at
  useEffect(() => {
    if (at) setSpark((pts) => appendSpark(pts, Date.parse(at), value))
  }, [at, value])

  if (!f) return null

  const delta = lossDelta(showBaht ? f.deltaBaht : f.deltaPieces)
  const pending = showBaht ? f.pendingBaht : f.pendingPieces
  // "the same point" of the previous period: a clock time for a day, with the
  // weekday for a week and the date for a month.
  const periodName = summary.period?.name
  const elapsed = summary.period?.end
    ? new Date(summary.period.end).toLocaleString([], {
      ...(periodName === 'week' ? { weekday: 'short' } : periodName === 'month' ? { day: 'numeric' } : {}),
      hour: '2-digit', minute: '2-digit',
    })
    : ''
  const prevLabel = { today: 'yesterday', week: 'last week', month: 'last month' }[periodName] || 'previous'

  return (
    <div className={styles.meter}>
      {spark.length > 1 && <Spark points={spark} />}
      <div className={`${styles.meter__big} ${styles.num} ${mode === 'lost' && !showBaht ? styles['meter__big--neutral'] : ''}`}>
        {showBaht ? fmtBaht(f.baht) : (
          <>
            {fmtPieces(f.pieces)}
            <span className={styles.meter__unit}>{tr('pcs')}</span>
          </>
        )}
      </div>
      <div className={`${styles.meter__sub} ${styles.num}`}>
        {showBaht
          ? `${fmtPieces(f.pieces)} ${tr('pcs')} × ${fmtBaht(summary.cost_per_piece)}`
          : tr(mode === 'defects' ? 'Defects this period' : 'Stops and slow running')}
      </div>
      <div className={`${styles.meter__row} ${styles.num}`}>
        {delta && (
          <span className={styles[`delta--${delta.tone}`]}>
            {delta.arrow} {showBaht ? fmtBaht(Math.abs(f.deltaBaht)) : `${fmtPieces(Math.abs(f.deltaPieces))} ${tr('pcs')}`}
            {' '}{tr(`vs ${prevLabel} {time}`, { time: elapsed })}
          </span>
        )}
        {pending > 0.5 && (
          <span className={styles.pending} title={tr('A stop still in progress — counted once it ends, or dropped if it outlasts the cutoff')}>
            + {showBaht ? fmtBaht(pending) : `${fmtPieces(pending)} ${tr('pcs')}`} {tr('pending')}
          </span>
        )}
      </div>
    </div>
  )
}

function Spark({ points }) {
  const t0 = points[0][0]
  const t1 = points[points.length - 1][0]
  const max = Math.max(...points.map((p) => p[1])) || 1
  const xy = points.map(([t, v]) => `${t1 > t0 ? ((t - t0) / (t1 - t0)) * 100 : 0},${60 - (v / max) * 56}`)
  return (
    <svg className={styles.meter__spark} viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={xy.join(' ')} />
    </svg>
  )
}
