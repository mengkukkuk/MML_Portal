import { useMemo } from 'react'
import { useTranslation } from '@/i18n'
import { waterfallBars, fmtBaht, fmtPieces } from '../kpiView'
import styles from './Blocks.module.css'

// Bars use this share of the column height, leaving headroom for the labels
// that sit on top of the tallest (potential) bar.
const HEADROOM = 0.8

/**
 * LossWaterfall — where the possible output went: possible → − stops →
 * − slow running → − defects → good. Vertical bars stepping down, joined by
 * dashed lines; the largest loss in the alarm colour, so the eye lands on it.
 *
 * Plain DOM rather than ECharts: five bars stay crisp at any tile size, and
 * the geometry (kpiView.waterfallBars) is unit-tested. The server derives
 * possible output from the other figures, so the steps always add up.
 */
export default function LossWaterfall({ summary }) {
  const tr = useTranslation()
  const bars = useMemo(() => waterfallBars(summary?.totals), [summary])
  if (!bars.length) return null
  const baht = summary.totals.baht
  const price = summary.cost_per_piece
  const sources = new Set((summary.families || []).map((f) => f.target_source))
  const targetNote = sources.has('set') && !sources.has('auto') ? tr('target set') : tr('target auto (p95, 7 days)')

  return (
    <>
      <div className={styles.wf} role="img" aria-label={bars.map((b) => `${tr(b.label)} ${fmtPieces(b.value)}`).join(', ')}>
        {bars.map((b, i) => {
          const sign = b.kind === 'loss' && Math.round(b.value) > 0 ? '−' : ''
          const next = bars[i + 1]
          return (
            <div key={b.key} className={styles.wf__col}>
              <div
                className={`${styles.wf__bar} ${b.kind === 'loss' ? styles['wf__bar--loss'] : ''} ${b.kind === 'good' ? styles['wf__bar--good'] : ''} ${b.largest ? styles['wf__bar--largest'] : ''}`}
                style={{ bottom: `${b.bottom * HEADROOM * 100}%`, height: `${b.height * HEADROOM * 100}%` }}
              />
              {next && <div className={styles.wf__link} style={{ bottom: `${b.level * HEADROOM * 100}%` }} />}
              <div
                className={`${styles.wf__val} ${styles.num} ${b.largest ? styles['wf__val--largest'] : ''}`}
                style={{ bottom: `${(b.bottom + b.height) * HEADROOM * 100}%` }}
              >
                {sign}{fmtPieces(b.value)}
                {baht && price != null && <span className={styles.wf__baht}>{sign}{fmtBaht(b.value * price)}</span>}
              </div>
            </div>
          )
        })}
        {bars.map((b) => (
          <div key={`l-${b.key}`} className={`${styles.wf__label} ${b.largest ? styles['wf__label--largest'] : ''}`}>
            {tr(b.label)}
          </div>
        ))}
      </div>
      <p className={styles.foot}>
        {targetNote}
        {' · '}{tr('stops over {m} min count as not scheduled', { m: summary.settings?.max_loss_stop_min ?? 120 })}
        {summary.settings?.working_hours && ` · ${tr('working hours {start}–{end}', summary.settings.working_hours)}`}
        {baht && price != null && ` · ${fmtBaht(price)}/${tr('pc')}`}
      </p>
    </>
  )
}
