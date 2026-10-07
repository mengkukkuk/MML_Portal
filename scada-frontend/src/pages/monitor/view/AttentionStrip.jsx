import { formatValue } from '@/components/mimic/tagStatus'
import { useTranslation } from '@/i18n'
import styles from '../MonitorPage.module.css'

/**
 * สิ่งที่ต้องจัดการ — every symbol on the sheet, the ones needing a person
 * first: alarm, then off-normal, then not connected, then the healthy rest.
 * Clicking an entry selects the symbol on the drawing. The caller renders
 * nothing for an empty drawing; the bare strip would just be a box with
 * nothing in it. `attention` comes from `rankAttention` (monitorStatus.js).
 */
export default function AttentionStrip({ attention, selectedId, onSelect }) {
  const tr = useTranslation()
  return (
    <section className={styles.strip} aria-label={tr('Things to handle')}>
      <div className={styles.stripHead}>
        <span className={styles.stripTitle}>{tr('Things to handle')}</span>
        <span className={styles.stripCounts}>
          {attention.crit > 0 && <span className={styles.countCrit}>{tr('{count} alarm', { count: attention.crit })}</span>}
          {attention.warn > 0 && <span className={styles.countWarn}>{tr('{count} off normal', { count: attention.warn })}</span>}
          {attention.unbound > 0 && <span className={styles.countUnbound}>{tr('{count} not connected', { count: attention.unbound })}</span>}
          {!attention.crit && !attention.warn && !attention.unbound && (
            <span className={styles.countOk}>{tr('Nothing needs attention')}</span>
          )}
        </span>
      </div>
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
    </section>
  )
}
