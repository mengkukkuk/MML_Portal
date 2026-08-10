import Button from '@mui/material/Button'
import LinkOutlined from '@mui/icons-material/LinkOutlined'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import { SYMBOLS } from '@/components/mimic/symbols'
import styles from './NodeInspector.module.css'

/**
 * NodeInspector — the edit-mode rail when a symbol is selected.
 *
 * Edit mode used to swap the whole rail for the symbol palette, which left no
 * per-symbol surface on the click path at all — and "click a symbol to choose
 * its data source" is the whole point of commissioning a drawing. So the rail
 * now shows the palette when nothing is selected and this when something is.
 */
export default function NodeInspector({
  node, datasources = [], onConnect, onDelete, onBack,
}) {
  const def = SYMBOLS[node.type]
  const b = node.binding
  const connection = b?.datasource_id == null
    ? 'Default (app database)'
    : datasources.find((d) => d.id === b.datasource_id)?.name
      ?? `Connection ${b.datasource_id} (missing)`

  return (
    <aside className={styles.rail}>
      <div className={styles.head}>
        <button type="button" className={styles.back} onClick={onBack}>← All symbols</button>
        <span className={styles.eyebrow}>{def?.label}</span>
        <span className={styles.name}>{node.label}</span>
        <span className={styles.tagId}>{node.tagId || 'no tag id'}</span>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Data source</div>

        {b ? (
          <dl className={styles.summary}>
            <dt>Connection</dt>
            <dd>{connection}</dd>
            <dt>Table</dt>
            <dd className={styles.mono}>{b.table}</dd>
            <dt>Column</dt>
            <dd className={styles.mono}>{b.value_col}</dd>
            {b.filter_col && (
              <>
                <dt>Device</dt>
                <dd className={styles.mono}>{b.filter_val}</dd>
              </>
            )}
            <dt>History</dt>
            <dd className={styles.mono}>{b.ts_col || 'current value only'}</dd>
            {b.expr && (
              <>
                <dt>Expression</dt>
                <dd className={styles.mono}>{b.expr}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className={styles.unbound}>
            Not connected. This symbol is drawn on the plant but has no reading behind it.
          </p>
        )}

        <Button
          fullWidth
          variant={b ? 'outlined' : 'contained'}
          color={b ? 'inherit' : 'primary'}
          startIcon={<LinkOutlined />}
          onClick={onConnect}
        >
          {b ? 'Edit connection' : 'Connect data source'}
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Placement</div>
        <p className={styles.hint}>
          Drag to move. Arrow keys nudge by one grid step, Shift for one unit.
        </p>
        <Button
          fullWidth
          color="error"
          startIcon={<DeleteOutlineOutlined />}
          onClick={() => onDelete(node.id)}
        >
          Remove symbol
        </Button>
      </div>
    </aside>
  )
}
