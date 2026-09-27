import { useMemo } from 'react'
import { SYMBOL_CATEGORIES, symbolDef } from '@/components/mimic/symbols'
import { categoryColor } from '@/components/mimic/symbolColors'
import styles from './CategoryLegend.module.css'

/**
 * CategoryLegend — the key to a colour-by-category sheet.
 *
 * Only the categories actually on this drawing, in palette order, each with
 * its colour and how many symbols carry it. Without a key, "why is this one
 * amber" has two answers on a SCADA sheet — its discipline, or a warning —
 * and the viewer can't tell which; with it, amber-by-category is stated and
 * anything else amber is a status.
 *
 * Renders nothing unless the drawing has colour-by-category on.
 */
export default function CategoryLegend({ layout }) {
  const theme = layout?.theme
  const entries = useMemo(() => {
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

  if (!entries.length) return null

  return (
    <ul className={styles.legend} aria-label="Symbol categories">
      {entries.map((c) => (
        <li key={c.id} className={styles.item}>
          <span className={styles.swatch} style={{ background: c.color }} aria-hidden="true" />
          {c.label}
          <span className={styles.count}>{c.count}</span>
        </li>
      ))}
    </ul>
  )
}
