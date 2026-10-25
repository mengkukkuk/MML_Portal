import { useTranslation } from '@/i18n'
import panelStyles from './LivePanel.module.css'
import styles from './MoveToPage.module.css'

/**
 * MoveToPage — the gear's "move this panel to page N" row (admin, on a
 * dashboard with more than one page). `move` is { page, count, onMove(n) }.
 */
export default function MoveToPage({ move, onDone }) {
  const tr = useTranslation()
  if (!move || move.count <= 1) return null
  return (
    <>
      <div className={panelStyles.gearpop__divider} />
      <div className={panelStyles.gearpop__row}>
        <span className={panelStyles.gearpop__label}>{tr('Move to page')}</span>
        <span className={styles.nums} role="group" aria-label={tr('Move to page')}>
          {Array.from({ length: move.count }, (_, i) => (
            <button key={i} type="button" className={styles.num} disabled={i === move.page}
              aria-label={i === move.page ? tr('On page {n}', { n: i + 1 }) : tr('Move to page {n}', { n: i + 1 })}
              onClick={() => { onDone?.(); move.onMove(i) }}>
              {i + 1}
            </button>
          ))}
        </span>
      </div>
    </>
  )
}
