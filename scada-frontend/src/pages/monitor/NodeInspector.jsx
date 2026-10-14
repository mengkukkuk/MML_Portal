import Button from '@mui/material/Button'
import LinkOutlined from '@mui/icons-material/LinkOutlined'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import Rotate90DegreesCwOutlined from '@mui/icons-material/Rotate90DegreesCwOutlined'
import { symbolDef, bubbleSpec, bubbleMoved } from '@/components/mimic/symbols'
import { BUBBLE_SHAPES, bubbleHidden, bubbleShape } from '@/components/mimic/bubbleShape'
import { LABEL_PLACES, labelPlace } from '@/components/mimic/labelPlacement'
import SymbolOptions, { SymbolColour } from './SymbolOptions'
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
  onOptions, onBack, theme, onTheme,
}) {
  const def = symbolDef(node)
  const b = node.binding
  const bubble = bubbleSpec(node)
  const resized = node.w !== def?.defaultSize.w || node.h !== def?.defaultSize.h
  const rot = ((Math.round(node.rot || 0) % 360) + 360) % 360

  // Undefined means "use the drawing's default" — resolved here so both the
  // stepper's readout and its disabled-reset state agree on what "default"
  // means, the same way `resized`/`rot` above resolve their own defaults.
  const labelSize = node.options?.labelSize ?? 12
  const place = labelPlace(node.options)
  const titleOff = def?.labelPlacement && place === 'hidden'
  const bubbleSize = node.options?.bubbleSize ?? 34
  const balloonOff = bubbleHidden(node)
  const shape = bubbleShape(node.options)
  const setLabelSize = (v) => onOptions(node.id, { labelSize: Math.max(8, Math.min(32, v)) })
  const captionOff = !!node.options?.captionHidden
  const captionSize = node.options?.captionSize
  // Stepping off "Auto" starts from 10px, the size every caption used to be.
  const stepCaption = (d) => onOptions(node.id, {
    captionSize: Math.max(6, Math.min(32, (captionSize ?? 10) + d)),
  })
  const setBubbleSize = (v) => onOptions(node.id, { bubbleSize: Math.max(16, Math.min(80, v)) })
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

      {onTheme && (
        <SymbolColour
          node={node}
          def={def}
          theme={theme}
          onOptions={(patch) => onOptions(node.id, patch)}
          onTheme={onTheme}
        />
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Title</div>
        <p className={styles.hint}>
          {def?.labelPlacement
            ? 'Where the name sits around the symbol, and its font size. The position follows the box edge, so it holds when the symbol is resized or rotated.'
            : 'Font size of the name printed under the symbol.'}
        </p>
        {def?.labelPlacement && (
          <div className={styles.rotRow} role="group" aria-label="Title position">
            {LABEL_PLACES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`${styles.rotBtn} ${place === id ? styles.rotOn : ''}`}
                aria-pressed={place === id}
                onClick={() => onOptions(node.id, { labelPlace: id === 'below' ? undefined : id })}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className={styles.rotRow} role="group" aria-label="Title font size">
          <button
            type="button"
            className={styles.rotBtn}
            disabled={titleOff}
            onClick={() => setLabelSize(labelSize - 2)}
          >
            −
          </button>
          <span className={styles.rotValue}>{labelSize}px</span>
          <button
            type="button"
            className={styles.rotBtn}
            disabled={titleOff}
            onClick={() => setLabelSize(labelSize + 2)}
          >
            +
          </button>
        </div>
        <Button
          fullWidth
          color="inherit"
          startIcon={<RestartAltOutlined />}
          disabled={node.options?.labelSize == null && node.options?.labelPlace == null}
          onClick={() => onOptions(node.id, { labelSize: undefined, labelPlace: undefined })}
        >
          Reset to default
        </Button>
      </div>

      {def?.caption && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Caption</div>
          <p className={styles.hint}>
            The small legend inside the face (tag id or table name). On Auto it
            scales with the box and shrinks to fit its width; hiding it gives the
            space back to the reading.
          </p>
          <div className={styles.rotRow} role="group" aria-label="Caption visibility">
            {[[false, 'Shown'], [true, 'Hidden']].map(([off, text]) => (
              <button
                key={text}
                type="button"
                className={`${styles.rotBtn} ${captionOff === off ? styles.rotOn : ''}`}
                aria-pressed={captionOff === off}
                onClick={() => onOptions(node.id, { captionHidden: off ? true : undefined })}
              >
                {text}
              </button>
            ))}
          </div>
          <div className={styles.rotRow} role="group" aria-label="Caption font size">
            <button
              type="button"
              className={styles.rotBtn}
              disabled={captionOff}
              onClick={() => stepCaption(-1)}
            >
              −
            </button>
            <span className={styles.rotValue}>{captionSize == null ? 'Auto' : `${captionSize}px`}</span>
            <button
              type="button"
              className={styles.rotBtn}
              disabled={captionOff}
              onClick={() => stepCaption(1)}
            >
              +
            </button>
          </div>
          <Button
            fullWidth
            color="inherit"
            startIcon={<RestartAltOutlined />}
            disabled={captionSize == null && !captionOff}
            onClick={() => onOptions(node.id, { captionSize: undefined, captionHidden: undefined })}
          >
            Reset to auto
          </Button>
        </div>
      )}

      {bubble && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Balloon</div>
          <div className={styles.rotRow} role="group" aria-label="Balloon visibility">
            {[[false, 'Shown'], [true, 'Hidden']].map(([off, text]) => (
              <button
                key={text}
                type="button"
                className={`${styles.rotBtn} ${balloonOff === off ? styles.rotOn : ''}`}
                aria-pressed={balloonOff === off}
                onClick={() => onOptions(node.id, { bubbleHidden: off ? true : undefined })}
              >
                {text}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            {balloonOff
              ? 'The reading is not drawn on the sheet. Its data source is unchanged.'
              : 'Drag the reading itself to move it. The offset is kept from the symbol, so the balloon travels with it.'}
          </p>
          <div className={styles.rotRow} role="group" aria-label="Balloon shape">
            {BUBBLE_SHAPES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`${styles.rotBtn} ${shape === id ? styles.rotOn : ''}`}
                aria-pressed={shape === id}
                disabled={balloonOff}
                onClick={() => onOptions(node.id, { bubbleShape: id === 'circle' ? undefined : id })}
              >
                {label}
              </button>
            ))}
          </div>
          <dl className={styles.summary}>
            <dt>Offset</dt>
            <dd className={styles.mono}>{bubble.offset[0]}, {bubble.offset[1]}</dd>
          </dl>
          <Button
            fullWidth
            color="inherit"
            startIcon={<RestartAltOutlined />}
            disabled={balloonOff || !bubbleMoved(node)}
            onClick={() => onResetBubble(node.id)}
          >
            Reset balloon position
          </Button>

          <div className={styles.rotRow} role="group" aria-label="Balloon size">
            <button
              type="button"
              className={styles.rotBtn}
              disabled={balloonOff}
              onClick={() => setBubbleSize(bubbleSize - 4)}
            >
              −
            </button>
            <span className={styles.rotValue}>{bubbleSize}px</span>
            <button
              type="button"
              className={styles.rotBtn}
              disabled={balloonOff}
              onClick={() => setBubbleSize(bubbleSize + 4)}
            >
              +
            </button>
          </div>
          <Button
            fullWidth
            color="inherit"
            startIcon={<RestartAltOutlined />}
            disabled={balloonOff || node.options?.bubbleSize == null}
            onClick={() => onOptions(node.id, { bubbleSize: undefined })}
          >
            Reset balloon size
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
