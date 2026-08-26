import Button from '@mui/material/Button'
import LinkOutlined from '@mui/icons-material/LinkOutlined'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import Rotate90DegreesCwOutlined from '@mui/icons-material/Rotate90DegreesCwOutlined'
import { symbolDef, bubbleSpec, bubbleMoved } from '@/components/mimic/symbols'
import SymbolOptions from './SymbolOptions'
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
  node, datasources = [], onConnect, onDelete, onResetBubble, onResetSize, onRotate,
  onOptions, onBack,
}) {
  const def = symbolDef(node)
  const b = node.binding
  const bubble = bubbleSpec(node)
  const resized = node.w !== def?.defaultSize.w || node.h !== def?.defaultSize.h
  const rot = ((Math.round(node.rot || 0) % 360) + 360) % 360
  const connection = b?.datasource_id == null
    ? 'Follow header selection'
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

      {/* Directly under the data source, because every option here is a rule
          about the reading above it — a colour rule reads nothing until that
          says which column, and the two are edited in one sitting. */}
      <SymbolOptions node={node} onChange={(patch) => onOptions(node.id, patch)} />

      {bubble && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Balloon</div>
          <p className={styles.hint}>
            Drag the reading itself to move it. The offset is kept from the
            symbol, so the balloon travels with it.
          </p>
          <dl className={styles.summary}>
            <dt>Offset</dt>
            <dd className={styles.mono}>{bubble.offset[0]}, {bubble.offset[1]}</dd>
          </dl>
          <Button
            fullWidth
            color="inherit"
            startIcon={<RestartAltOutlined />}
            disabled={!bubbleMoved(node)}
            onClick={() => onResetBubble(node.id)}
          >
            Reset balloon position
          </Button>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Size</div>
        <p className={styles.hint}>
          Drag any grip on the symbol&rsquo;s edge to resize it. Hold Shift on a
          corner to keep its proportions. Ports move with the box, so its wires
          re-route themselves.
        </p>
        <dl className={styles.summary}>
          <dt>Width × height</dt>
          <dd className={styles.mono}>{Math.round(node.w)} × {Math.round(node.h)}</dd>
        </dl>
        <Button
          fullWidth
          color="inherit"
          startIcon={<RestartAltOutlined />}
          disabled={!resized}
          onClick={() => onResetSize(node.id)}
        >
          Reset to drawn size
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Rotation</div>
        <p className={styles.hint}>
          Quarter turns cover most of it — a duct, an arrow, a conveyor running the
          other way. Ports rotate with the symbol, so its wires follow.
        </p>
        <div className={styles.rotRow} role="group" aria-label="Rotate symbol">
          {[0, 90, 180, 270].map((deg) => (
            <button
              key={deg}
              type="button"
              className={`${styles.rotBtn} ${rot === deg ? styles.rotOn : ''}`}
              aria-pressed={rot === deg}
              onClick={() => onRotate(node.id, deg)}
            >
              {deg}°
            </button>
          ))}
        </div>
        <div className={styles.rotRow}>
          {/* Fine adjustment, for a symbol that has to line up with something
              drawn at an angle. Wrapped into 0–359 so the readout never creeps
              off to 720°. */}
          <button
            type="button"
            className={styles.rotBtn}
            onClick={() => onRotate(node.id, (rot + 345) % 360)}
          >
            −15°
          </button>
          <span className={styles.rotValue}>{rot}°</span>
          <button
            type="button"
            className={styles.rotBtn}
            onClick={() => onRotate(node.id, (rot + 15) % 360)}
          >
            +15°
          </button>
        </div>
        <Button
          fullWidth
          color="inherit"
          startIcon={<Rotate90DegreesCwOutlined />}
          disabled={rot === 0}
          onClick={() => onRotate(node.id, 0)}
        >
          Reset to upright
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Placement</div>
        <p className={styles.hint}>
          Drag to move. Arrow keys nudge by one grid step, Shift for one unit.
          Drag from any port dot to run a wire to another symbol.
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
