import { useTranslation } from '@/i18n'
import { stripTiles } from '../kpiView'
import styles from './Blocks.module.css'

/**
 * KpiStrip — up to six headline numbers in one row: good vs plan, yield,
 * running time, pieces at risk, blind time, response time (the Line 13
 * dashboard's executive tiles), or whichever the block's settings pick.
 * Colour carries the verdict — red for a problem, amber for a warning — so the
 * board reads the row before the digits. Money tiles drop out for viewers who
 * may not see cost.
 */
export default function KpiStrip({ summary }) {
  const tr = useTranslation()
  const tiles = stripTiles(summary)
  if (!tiles.length) return <p className={styles.empty}>{tr('Choose metrics in block settings.')}</p>
  return (
    <div className={styles.strip}>
      {tiles.map((t) => (
        <div key={t.key} className={styles.strip__tile}>
          <span className={styles.strip__label}>{tr(t.label)}</span>
          <span className={`${styles.strip__value} ${styles.num} ${t.tone ? styles[`tone--${t.tone}`] : ''}`}>{t.value}</span>
          {t.sub && <span className={styles.strip__sub}>{Array.isArray(t.sub) ? tr(...t.sub) : tr(t.sub)}</span>}
        </div>
      ))}
    </div>
  )
}
