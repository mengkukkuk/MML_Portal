import Button from '@mui/material/Button'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import { SYMBOLS } from '@/components/mimic/symbols'
import {
  NORMAL_WIRE, WIRE_GROUPED, WireSample, wireType,
} from '@/components/mimic/wireTypes'
import styles from './EdgeInspector.module.css'

/**
 * EdgeInspector — the edit-mode rail for one selected wire.
 *
 * A wire lands in whatever type the pen was set to, which is usually right and
 * occasionally not — so this is where one line gets corrected without changing
 * what the next one will be. The drive behind it is a separate decision: its
 * dashes only march when the pump or feeder pushing through it is running, and
 * nothing at draw time could have guessed which symbol that is.
 */
export default function EdgeInspector({
  edge, nodes, onChange, onDelete, onBack,
}) {
  const current = edge.service ?? NORMAL_WIRE
  const endpoint = (end) => {
    const node = nodes.find((n) => n.id === end.node)
    if (!node) return { name: 'missing symbol', detail: end.node }
    return { name: node.label || node.id, detail: `${SYMBOLS[node.type]?.label ?? node.type} · ${end.port}` }
  }

  const from = endpoint(edge.from)
  const to = endpoint(edge.to)

  return (
    <aside className={styles.rail}>
      <div className={styles.head}>
        <button type="button" className={styles.back} onClick={onBack}>← All symbols</button>
        <span className={styles.eyebrow}>Wire</span>
        <span className={styles.name}>{from.name} → {to.name}</span>
        <span className={styles.ports}>{from.detail} → {to.detail}</span>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Wire type</div>
        {WIRE_GROUPED.map((group) => (
          <div key={group.id} className={styles.typeGroup}>
            <div className={styles.groupName}>{group.label}</div>
            <div className={styles.types} role="radiogroup" aria-label={`${group.label} wire types`}>
              {group.ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={current === id}
                  className={`${styles.type} ${current === id ? styles.typeOn : ''}`}
                  onClick={() => onChange({ service: id })}
                >
                  {/* Drawn by the same code as the canvas, so the swatch is the
                      line rather than an impression of it. */}
                  <span className={styles.swatch}>
                    <WireSample id={id} width={30} height={12} />
                  </span>
                  {wireType(id).label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className={styles.hint}>
          Changing this also sets the wire type for the next line you draw.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Flow</div>
        <label className={styles.field}>
          <span>Driven by</span>
          <select
            value={edge.flowNode ?? ''}
            onChange={(e) => onChange({ flowNode: e.target.value || null })}
          >
            <option value="">Always flowing</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>{n.label || n.id}</option>
            ))}
          </select>
        </label>
        <p className={styles.hint}>
          The pump, drive or feeder that moves product or power along this line.
          Its dashes stop marching when that symbol reads stopped or open.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Route</div>
        <p className={styles.hint}>
          Elbows are drawn from the two ports and follow them — move or resize
          either symbol and the wire re-routes itself.
        </p>
        <Button
          fullWidth
          color="error"
          startIcon={<DeleteOutlineOutlined />}
          onClick={() => onDelete(edge.id)}
        >
          Remove wire
        </Button>
      </div>
    </aside>
  )
}
