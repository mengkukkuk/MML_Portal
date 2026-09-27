import { useMemo } from 'react'
import { SYMBOL_CATEGORIES, symbolDef } from '@/components/mimic/symbols'
import { categoryColor } from '@/components/mimic/symbolColors'
import { useTranslation } from '@/i18n'
import styles from './TitleBlock.module.css'

/**
 * TitleBlock — the box in the corner of every engineering drawing that says
 * what the sheet is, and carries its key.
 *
 * Pinned to the stage's bottom-right corner (the sheet's own key for wire
 * styles already owns bottom-left), outside the drawing's coordinates so it
 * stays readable at any zoom. Cells, in reading order:
 *   drawing name · the time the figures on screen are from
 *   the category key — only when the drawing is colour-coded by category,
 *     and only the categories actually on it, with how many symbols each.
 *
 * The key is why this exists as more than decoration: on a SCADA sheet,
 * "why is that one amber" has two answers — its discipline, or a warning —
 * and the key states the first so anything else amber reads as the second.
 */
export default function TitleBlock({ layout, name, asOf }) {
  const tr = useTranslation()
  const theme = layout?.theme

  const key = useMemo(() => {
    if (!theme?.byCategory) return []
    const counts = new Map()
    for (const node of layout?.nodes ?? []) {
      const category = symbolDef(node)?.category
      if (category) counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return SYMBOL_CATEGORIES
      .filter((c) => counts.has(c.id))
      .map((c) => ({ ...c, count: counts.get(c.id), color: categoryColor(theme, c.id) }))
      .filter((c) => c.color)
  }, [layout?.nodes, theme])

  return (
    <aside className={styles.block} aria-label={tr('Drawing title block')}>
      <div className={`${styles.cell} ${styles.cellWide}`}>
        <span className={styles.label}>{tr('Drawing')}</span>
        <span className={styles.name}>{name}</span>
      </div>
      <div className={styles.cell}>
        <span className={styles.label}>{tr('As of')}</span>
        <span className={styles.value}>{asOf}</span>
      </div>
      {key.length > 0 && (
        <ul className={`${styles.cell} ${styles.key}`} aria-label={tr('Symbol categories')}>
          {key.map((c) => (
            <li key={c.id} className={styles.keyItem}>
              <span className={styles.swatch} style={{ background: c.color }} aria-hidden="true" />
              <span className={styles.keyLabel}>{tr(c.label)}</span>
              <span className={styles.keyCount}>{c.count}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
