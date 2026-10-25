import { useMemo } from 'react'
import { useTranslation } from '@/i18n'
import { hourlyBars, fmtPieces, fmtCompact } from '../kpiView'
import styles from './Blocks.module.css'

const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)
// The tallest bar's share of the column: the rest is headroom for its labels.
const TOP = 72

/**
 * HourlyRate — the defect rate per hour (per day for a week or month), red
 * where it beat the period's own average: "when did quality slip". The dashed
 * line is that average. Hours the line made nothing stay as an empty slot
 * rather than a zero bar, which would read as a perfect hour.
 */
export default function HourlyRate({ summary }) {
  const tr = useTranslation()
  const rows = summary?.hourly?.rows
  const { avg, bars } = useMemo(() => hourlyBars(rows), [rows])
  if (!bars.length) return null
  const daily = (summary.hourly.size_min || 60) >= 1440
  const label = (iso) => {
    const d = new Date(iso)
    return daily ? `${d.getDate()}/${d.getMonth() + 1}` : String(d.getHours()).padStart(2, '0')
  }
  const used = bars.filter((b) => !b.empty)
  const shown = daily ? bars : bars.slice(
    Math.max(0, bars.indexOf(used[0]) - 1),
    used.length ? bars.lastIndexOf(used[used.length - 1]) + 2 : bars.length,
  )
  const avgShare = avg != null && used.length ? avg / Math.max(...used.map((b) => b.rate || 0)) : null
  return (
    <>
      <div className={styles.hr} role="img"
        aria-label={shown.map((b) => `${label(b.start)} ${pct(b.rate)}`).join(', ')}>
        {avgShare != null && <div className={styles.hr__avg} style={{ bottom: `${avgShare * TOP}%` }} />}
        {shown.map((b) => (
          <div key={b.start} className={styles.hr__col} title={b.empty ? '' : `${pct(b.rate, 2)} · ${fmtPieces(b.defects)} / ${fmtPieces(b.pieces)}`}>
            <div className={`${styles.hr__bar} ${b.above ? styles['hr__bar--above'] : ''} ${b.empty ? styles['hr__bar--empty'] : ''}`}
              style={{ height: `${b.share * TOP}%` }} />
            {!b.empty && (
              // defects in the bucket, then the rate the bar's height shows
              <span className={styles.hr__val} style={{ bottom: `${b.share * TOP}%` }}>
                <strong className={b.above ? styles['tone--bad'] : undefined}>{fmtCompact(b.defects)}</strong>
                <span className={styles.hr__rate}>{pct(b.rate, 2)}</span>
              </span>
            )}
            <span className={styles.hr__lbl}>{label(b.start)}</span>
          </div>
        ))}
      </div>
      <p className={styles.foot}>
        {tr('red = above the period average')} {avg != null && `(${pct(avg, 2)})`}
      </p>
    </>
  )
}
