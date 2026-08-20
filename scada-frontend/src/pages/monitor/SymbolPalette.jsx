import { useMemo, useState } from 'react'
import AddPhotoAlternateOutlined from '@mui/icons-material/AddPhotoAlternateOutlined'
import {
  SYMBOLS, SYMBOL_GROUPS, customDescriptor,
} from '@/components/mimic/symbols'
import styles from './MonitorPage.module.css'

/**
 * One palette entry — previews the real symbol component rather than an icon.
 * These are drawings, and a list of words would not tell an operator which one
 * is the damper and which is the photo eye.
 *
 * `def` is passed rather than looked up so this draws an authored symbol and a
 * built-in one through the same path: whatever the canvas would render for that
 * descriptor is what appears here.
 */
function PaletteItem({ def, label, onAdd }) {
  const { Component, defaultSize } = def
  const node = {
    id: `palette-${label}`, type: 'palette', label: '', x: 0, y: 0, ...defaultSize, rot: 0,
  }

  return (
    <button
      type="button"
      className={styles.paletteItem}
      onClick={onAdd}
      title={`Add ${label}`}
    >
      <svg
        className={styles.paletteSvg}
        viewBox={`-6 -6 ${defaultSize.w + 12} ${defaultSize.h + 12}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <Component node={node} def={def} tag={null} />
      </svg>
      <span className={styles.paletteLabel}>{label}</span>
    </button>
  )
}

/**
 * SymbolPalette — edit-mode replacement for the detail rail, so the canvas
 * never has to shrink twice.
 *
 * Fifty symbols across six disciplines is a wall as one flat grid, so the
 * library is grouped and only Process opens by default: a drawing almost
 * always starts from the process and reaches for the switchgear afterwards.
 * The filter searches every group at once and forces matching ones open,
 * because someone who knows they want a "packer" should not have to guess
 * which discipline we filed it under.
 *
 * The Custom group is the one that is not shipped in this bundle: it lists what
 * admins have uploaded, so it is built from the library rather than from the
 * registry, and it grows without a deploy.
 */
export default function SymbolPalette({ onAdd, customSymbols = [], onAuthorSymbol }) {
  const [open, setOpen] = useState(() => new Set(['process']))
  const [query, setQuery] = useState('')

  const filter = query.trim().toLowerCase()

  /**
   * Every group, with its entries already resolved to `{ key, label, def, add }`.
   *
   * Built as one list so the filter, the open/closed state and the counts work
   * the same for uploaded symbols as for drawn ones — the alternative was a
   * second copy of all three behaviours for the Custom group alone.
   */
  const groups = useMemo(() => {
    const drawn = SYMBOL_GROUPS
      // `custom` is a registry type but not a palette entry: what an admin picks
      // is one authored symbol, never the generic slot they all share.
      .filter((g) => g.id !== 'custom')
      .map((g) => ({
        id: g.id,
        label: g.label,
        entries: g.types.map((type) => ({
          key: type,
          label: SYMBOLS[type].label,
          def: SYMBOLS[type],
          add: () => onAdd(type),
        })),
      }))

    const authored = {
      id: 'custom',
      label: 'Custom',
      entries: customSymbols.map((row) => ({
        key: `custom-${row.id}`,
        label: row.name,
        def: customDescriptor(row),
        add: () => onAdd('custom', row.id),
      })),
    }

    return [...drawn, authored]
      .map((g) => (filter
        ? {
          ...g,
          entries: g.entries.filter((e) => (
            e.label.toLowerCase().includes(filter) || e.key.includes(filter)
          )),
        }
        : g))
      // The Custom group survives an empty entry list when nothing is filtering,
      // because its header carries the Upload button — the one place an admin can
      // add the first authored symbol.
      .filter((g) => g.entries.length > 0 || (g.id === 'custom' && !filter))
  }, [customSymbols, filter, onAdd])

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
                <span className={styles.paletteCount}>{group.entries.length}</span>
              </button>

              {isOpen && (
                <>
                  <div className={styles.paletteGrid}>
                    {group.entries.map((entry) => (
                      <PaletteItem
                        key={entry.key}
                        def={entry.def}
                        label={entry.label}
                        onAdd={entry.add}
                      />
                    ))}
                  </div>

                  {group.id === 'custom' && onAuthorSymbol && (
                    <>
                      {group.entries.length === 0 && (
                        <p className={styles.paletteEmpty}>
                          Nothing uploaded yet. Add a picture of your own equipment and give it
                          motion driven by its tag.
                        </p>
                      )}
                      <button
                        type="button"
                        className={styles.paletteUpload}
                        onClick={onAuthorSymbol}
                      >
                        <AddPhotoAlternateOutlined fontSize="small" />
                        Add a symbol from an image
                      </button>
                    </>
                  )}
                </>
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
