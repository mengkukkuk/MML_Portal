import { useTranslation } from '@/i18n'
import { fmtBaht, fmtPieces } from '../kpiView'
import styles from './Blocks.module.css'

const TOP = 8

/**
 * DefectPareto — where the rejects came from, by camera and defect type,
 * largest first with the cumulative share beside each bar. The bars that make
 * up the first 80% are the vital few — but at most the top three are drawn in
 * the alarm colour, so emphasis survives a spread of many similar types.
 */
export default function DefectPareto({ summary }) {
  const tr = useTranslation()
  const items = (summary?.pareto?.items || []).slice(0, TOP)
  if (!items.length) return <p className={styles.empty}>{tr('No defects this period.')}</p>
  const max = items[0].defects
  let vital = true
  return (
    <div className={styles.pareto}>
      {items.map((x, i) => {
        const hot = vital && i < 3
        vital = x.cum_share < 0.8
        return (
          <div key={x.column} className={styles.pareto__row}>
            <span className={styles.pareto__name} title={x.column}>{x.item}</span>
            <span className={styles.pareto__track}>
              <span className={`${styles.pareto__bar} ${hot ? styles['pareto__bar--hot'] : ''}`}
                style={{ width: `${(x.defects / max) * 100}%` }} />
            </span>
            <span className={`${styles.pareto__val} ${styles.num}`}>
              {fmtPieces(x.defects)}{x.baht && ` · ${fmtBaht(x.baht.defects)}`} · {Math.round(x.cum_share * 100)}%
            </span>
          </div>
        )
      })}
      <p className={styles.foot}>{tr('red = the biggest types inside the first 80%')}</p>
    </div>
  )
}
