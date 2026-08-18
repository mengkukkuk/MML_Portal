import { useMemo, useState } from 'react'
import { SYMBOLS, SYMBOL_GROUPS } from '@/components/mimic/symbols'
import styles from './MonitorPage.module.css'

/**
 * One palette entry — previews the real symbol component rather than an icon.
 * These are drawings, and a list of words would not tell an operator which one
 * is the damper and which is the photo eye.
 */
function PaletteItem({ type, onAdd }) {
  const { label, Component, defaultSize } = SYMBOLS[type]
  const node = {
    id: `palette-${type}`, type, label: '', x: 0, y: 0, ...defaultSize, rot: 0,
  }

  return (
    <button
      type="button"
      className={styles.paletteItem}
      onClick={() => onAdd(type)}
      title={`Add ${label}`}
    >
      <svg
        className={styles.paletteSvg}
        viewBox={`-6 -6 ${defaultSize.w + 12} ${defaultSize.h + 12}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <Component node={node} tag={null} />
      </svg>
      <span className={styles.paletteLabel}>{label}</span>
    </button>
  )
}

/**
 * SymbolPalette — edit-mode replacement for the detail rail, so the canvas
 * never has to shrink twice.
 *
 * Forty symbols across five disciplines is a wall as one flat grid, so the
 * library is grouped and only Process opens by default: a drawing almost
 * always starts from the process and reaches for the switchgear afterwards.
 * The filter searches every group at once and forces matching ones open,
 * because someone who knows they want a "packer" should not have to guess
 * which discipline we filed it under.
 */
export default function SymbolPalette({ onAdd }) {
  const [open, setOpen] = useState(() => new Set(['process']))
  const [query, setQuery] = useState('')

  const filter = query.trim().toLowerCase()

  const groups = useMemo(() => {
    if (!filter) return SYMBOL_GROUPS
    return SYMBOL_GROUPS
      .map((g) => ({
        ...g,
        types: g.types.filter((t) => (
          SYMBOLS[t].label.toLowerCase().includes(filter) || t.includes(filter)
        )),
      }))
      .filter((g) => g.types.length > 0)
  }, [filter])

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <aside className={styles.palette}>
      <span className={styles.paletteHead}>Symbols</span>
      <p className={styles.paletteHint}>
        Click a symbol to drop it at the centre of the mimic. Drag to place it, arrow keys to
        nudge, edge grips to resize, Delete to remove it and its wires.
      </p>

      <input
        type="search"
        className={styles.paletteFilter}
        placeholder="Find a symbol"
        aria-label="Find a symbol"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className={styles.paletteGroups}>
        {groups.map((group) => {
          // A search that matched inside a collapsed group has to open it, or
          // the result is a list of headers and no way to see what matched.
          const isOpen = filter ? true : open.has(group.id)
          return (
            <div key={group.id}>
              <button
                type="button"
                className={`${styles.paletteGroupHead} ${isOpen ? styles.paletteGroupOpen : ''}`}
                aria-expanded={isOpen}
                onClick={() => toggle(group.id)}
              >
                <span className={`${styles.paletteChevron} ${isOpen ? styles.paletteChevronOpen : ''}`}>
                  ▶
                </span>
                <span className={styles.paletteGroupName}>{group.label}</span>
                <span className={styles.paletteCount}>{group.types.length}</span>
              </button>

              {isOpen && (
                <div className={styles.paletteGrid}>
                  {group.types.map((type) => (
                    <PaletteItem key={type} type={type} onAdd={onAdd} />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {groups.length === 0 && (
          <p className={styles.paletteEmpty}>No symbol matches “{query.trim()}”.</p>
        )}
      </div>
    </aside>
  )
}
