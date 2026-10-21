import { useTranslation } from '@/i18n'
import { trendDelta } from '../kpiView'
import styles from './Blocks.module.css'

const dayLabel = (iso) => { const d = new Date(iso); return `${d.getDate()}/${d.getMonth() + 1}` }

const METRICS = [
  { key: 'yield', label: 'Yield', fmt: (v) => `${(v * 100).toFixed(1)}%`, goodUp: true },
  { key: 'availability', label: 'Running time', fmt: (v) => `${Math.round(v * 100)}%`, goodUp: true },
  { key: 'blind_min', label: 'Blind time (min)', fmt: (v) => `${v}`, goodUp: false },
]

/**
 * KpiTrend — the last seven days of yield, running time and blind time as
 * small multiples, today's point coloured by whether it is worse than
 * yesterday. Always seven calendar days, whatever the block's period: a trend
 * is about the week, not about the current shift.
 */
export default function KpiTrend({ summary }) {
  const tr = useTranslation()
  const days = summary?.days || []
  if (!days.length) return null
  return (
    <div className={styles.trend}>
      {METRICS.filter((m) => days.some((d) => d[m.key] != null)).map((m) => {
        const vals = days.map((d) => d[m.key])
        const known = vals.filter((v) => v != null)
        const lo = Math.min(...known)
        const hi = Math.max(...known)
        const span = hi - lo || 1
        const pts = vals.map((v, i) => (v == null ? null : [6 + (i * 188) / Math.max(1, days.length - 1), 52 - ((v - lo) / span) * 40]))
        const { last, prev, worse } = trendDelta(days, m.key, m.goodUp)
        const lastPt = pts[pts.length - 1]
        return (
          <div key={m.key} className={styles.trend__card}>
            <span className={styles.strip__label}>{tr(m.label)}</span>
            <span className={`${styles.trend__value} ${styles.num} ${worse ? styles['tone--bad'] : ''}`}>
              {last == null ? '—' : m.fmt(last)}
            </span>
            <span className={styles.strip__sub}>{prev == null ? '' : `${tr('yesterday')} ${m.fmt(prev)}`}</span>
            <svg viewBox="0 0 200 72" className={styles.trend__svg} aria-hidden="true">
              <polyline points={pts.filter(Boolean).map((p) => p.join(',')).join(' ')} className={styles.trend__line} />
              {lastPt && <circle cx={lastPt[0]} cy={lastPt[1]} r="4" className={worse ? styles['trend__dot--bad'] : styles.trend__dot} />}
              <text x="6" y="70" className={styles.trend__day}>{dayLabel(days[0].date)}</text>
              <text x="194" y="70" textAnchor="end" className={styles.trend__day}>{dayLabel(days[days.length - 1].date)}</text>
            </svg>
          </div>
        )
      })}
    </div>
  )
}
