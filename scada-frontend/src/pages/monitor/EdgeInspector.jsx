import Button from '@mui/material/Button'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import { SYMBOLS } from '@/components/mimic/symbols'
import { SERVICES } from './MimicCanvas'
import styles from './EdgeInspector.module.css'

/**
 * EdgeInspector — the edit-mode rail for one selected pipe.
 *
 * A pipe drawn by hand lands with a provisional service and no drive behind
 * it, which is enough to see it but not enough to be right: what a line
 * carries is read off how it is drawn, and its dashes only march when the
 * pump pushing product through it is running. Both are decisions about the
 * plant, so both are made here rather than guessed at draw time.
 */
export default function EdgeInspector({
  edge, nodes, onChange, onDelete, onBack,
}) {
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
        <span className={styles.eyebrow}>Pipe</span>
        <span className={styles.name}>{from.name} → {to.name}</span>
        <span className={styles.ports}>{from.detail} → {to.detail}</span>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Service</div>
        <div className={styles.services} role="group" aria-label="Service">
          {SERVICES.map((svc) => (
            <button
              key={svc.id}
              type="button"
              className={`${styles.service} ${edge.service === svc.id ? styles.serviceOn : ''}`}
              aria-pressed={edge.service === svc.id}
              onClick={() => onChange({ service: svc.id })}
            >
              <span className={`${styles.swatch} ${styles[svc.id]}`} />
              {svc.label}
            </button>
          ))}
        </div>
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
          The pump, drive or valve that moves product along this line. Its dashes
          stop marching when that symbol reads stopped or closed.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Route</div>
        <p className={styles.hint}>
          Elbows are drawn from the two ports and follow them — move either
          symbol and the pipe re-routes itself.
        </p>
        <Button
          fullWidth
          color="error"
          startIcon={<DeleteOutlineOutlined />}
          onClick={() => onDelete(edge.id)}
        >
          Remove pipe
        </Button>
      </div>
    </aside>
  )
}
