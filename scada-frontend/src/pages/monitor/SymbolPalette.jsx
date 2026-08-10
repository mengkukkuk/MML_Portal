import { SYMBOLS, SYMBOL_TYPES } from '@/components/mimic/symbols'
import styles from './MonitorPage.module.css'

/**
 * SymbolPalette — edit-mode replacement for the detail rail, so the canvas
 * never has to shrink twice.
 *
 * Each entry previews the real symbol component rather than an icon: these
 * are drawings, and a list of words would not tell an operator which one is
 * the damper and which is the photo eye.
 */
export default function SymbolPalette({ onAdd }) {
  return (
    <aside className={styles.palette}>
      <span className={styles.paletteHead}>Symbols</span>
      <p className={styles.paletteHint}>
        Click a symbol to drop it at the centre of the mimic. Drag to place it, arrow keys to
        nudge, Delete to remove it and its pipes.
      </p>
      <div className={styles.paletteGrid}>
        {SYMBOL_TYPES.map((type) => {
          const def = SYMBOLS[type]
          const { Component, defaultSize } = def
          const node = {
            id: `palette-${type}`, type, label: '', x: 0, y: 0, ...defaultSize, rot: 0,
          }
          return (
            <button
              key={type}
              type="button"
              className={styles.paletteItem}
              onClick={() => onAdd(type)}
              title={`Add ${def.label}`}
            >
              <svg
                className={styles.paletteSvg}
                viewBox={`-6 -6 ${defaultSize.w + 12} ${defaultSize.h + 12}`}
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              >
                <Component node={node} tag={null} />
              </svg>
              <span className={styles.paletteLabel}>{def.label}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
