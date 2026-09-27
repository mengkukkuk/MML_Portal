import { useState } from 'react'
import Button from '@mui/material/Button'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import { symbolDef } from '@/components/mimic/symbols'
import { DEFAULT_FILL_OPACITY, cleanHex, cleanOpacity } from '@/components/mimic/symbolColors'
import { ColourRow } from './SymbolOptions'
import nodeStyles from './NodeInspector.module.css'
import styles from './SymbolOptions.module.css'

/**
 * GroupInspector — the edit-mode rail when a box or shift selection holds two
 * or more symbols.
 *
 * Only what makes sense for all of them at once: a shared colour and fill,
 * and delete. Moving is on the canvas (drag any member, or the arrow keys).
 * Per-symbol things — the data source, the title, the balloon — stay on the
 * single-symbol inspector, because "connect these nine symbols to one column"
 * is never what anyone means.
 *
 * The colour row shows a colour only when every member already shares it;
 * otherwise it reads "Mixed", so picking one is visibly a change to all.
 */
export default function GroupInspector({ nodes, onOptions, onDelete, onBack }) {
  const [open, setOpen] = useState(false)
  const colours = new Set(nodes.map((n) => cleanHex(n.options?.color)))
  const shared = colours.size === 1 ? [...colours][0] : null
  const mixed = colours.size > 1
  const opacities = new Set(nodes.map((n) => cleanOpacity(n.options?.colorOpacity) ?? DEFAULT_FILL_OPACITY))
  const opacity = opacities.size === 1 ? [...opacities][0] : DEFAULT_FILL_OPACITY

  // "3 IP cameras, 2 cartoners" — what is in the box, by kind.
  const kinds = new Map()
  for (const n of nodes) {
    const label = symbolDef(n)?.label ?? n.type
    kinds.set(label, (kinds.get(label) ?? 0) + 1)
  }

  return (
    <aside className={nodeStyles.rail}>
      <div className={nodeStyles.head}>
        <button type="button" className={nodeStyles.back} onClick={onBack}>← Clear selection</button>
        <span className={nodeStyles.eyebrow}>Selection</span>
        <span className={nodeStyles.name}>{nodes.length} symbols</span>
        <span className={nodeStyles.tagId}>
          {[...kinds].map(([label, n]) => `${n} × ${label}`).join(' · ')}
        </span>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Move</div>
        <p className={styles.hint}>
          Drag any selected symbol to move them all, or use the arrow keys
          (Shift for 1-unit steps). They move as one block and stop together at
          the sheet edge. Shift+click adds or removes a symbol; Ctrl+A selects all.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Colour</div>
        <ColourRow
          label="All selected"
          caption={mixed ? 'Mixed — picking one paints them all' : shared ? 'Shared colour' : 'Default look'}
          value={shared}
          open={open}
          onToggle={() => setOpen((o) => !o)}
          onPick={(hex) => { onOptions({ color: hex }); setOpen(false) }}
          onReset={shared || mixed ? () => onOptions({ color: null, colorOpacity: null }) : null}
          resetLabel="Clear"
          opacity={opacity}
          onOpacity={(v) => onOptions({ colorOpacity: v })}
        />
      </div>

      <div className={styles.section}>
        <Button
          fullWidth
          variant="outlined"
          color="error"
          startIcon={<DeleteOutlineOutlined />}
          onClick={onDelete}
        >
          Delete {nodes.length} symbols
        </Button>
        <p className={styles.hint}>Their wires go with them. Undo brings everything back.</p>
      </div>
    </aside>
  )
}
