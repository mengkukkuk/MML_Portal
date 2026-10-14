import { useRef, useState } from 'react'
import AddOutlined from '@mui/icons-material/AddOutlined'
import { formatValue } from '@/components/mimic/tagStatus'
import {
  KPI_LIMIT, KPI_MAX_WIDTH, KPI_MIN_WIDTH, clampKpiWidth, kpiIsBound,
} from './kpiBoxes'
import styles from './KpiStrip.module.css'

/**
 * KpiStrip — the headline numbers, above the drawing and inside the banner.
 *
 * Read-only it is a row of figures and nothing else: no controls, no affordance
 * to click, no reserved space when a mimic has none configured. That last part
 * matters more than it looks — this lands on live wall displays, and every
 * existing drawing must look exactly as it did until somebody deliberately puts
 * a number up.
 *
 * In edit mode the same row becomes the editor. A box is configured by clicking
 * the box, not by hunting for it in a dialog listing six anonymous slots, and
 * the `+` is always present so a strip with nothing in it still has something
 * to click.
 *
 * ## Widths
 *
 * A box is "auto" (an equal share of the row, as every box used to be) until
 * someone drags its right edge, which pins it to that many px. That is the fix
 * for a long figure being clipped: a lifetime production count does not fit in
 * a 170 px share, and no amount of font tuning makes ten digits fit in less
 * room — the box has to be allowed to be wider.
 *
 * The grip is a sibling of the box, never inside it: in edit mode the box is a
 * <button>, and a control nested in a button is invalid and steals its clicks.
 * The grip is also deliberately not draggable-as-HTML, so grabbing it can never
 * be mistaken for the reorder drag the box itself supports.
 *
 * ## Why the value comes in as a tag
 *
 * The strip prints `tags[kpi.id]`, the identical entry a symbol draws from, so
 * `formatValue` already handles the decimals and the not-yet-read em-dash, and
 * a box can never disagree with the drawing beneath it about what tick it is
 * showing. The only thing this file decides is how the figure is set.
 */

function bilingual(thai, english) {
  if (!thai && !english) return null
  if (!thai) return english
  return <>{thai}{english ? <small>{english}</small> : null}</>
}

/** Arrow-key resize step, and the larger step with Shift held. */
const KEY_STEP = 10
const KEY_STEP_LARGE = 40

export default function KpiStrip({
  kpis = [], tags = {}, editing = false, inBanner = false,
  onEdit, onAdd, onReorder, onResize,
}) {
  const dragFrom = useRef(null)
  const [dragOver, setDragOver] = useState(null)
  // The width a box is being dragged to, held here until release so a drag is
  // one edit in the document's history rather than one per pointer move.
  const [resizing, setResizing] = useState(null) // { id, width }

  // Nothing configured and nobody editing: the strip does not exist. Not a
  // collapsed band, not a hint — no element, so the drawing sits exactly where
  // it always did.
  if (!kpis.length && !editing) return null

  const move = (from, to) => {
    if (from == null || to == null || from === to) return
    const next = [...kpis]
    next.splice(to, 0, next.splice(from, 1)[0])
    onReorder?.(next)
  }

  const startResize = (event, kpi) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const grip = event.currentTarget
    const startX = event.clientX
    const startWidth = grip.parentElement.getBoundingClientRect().width
    let latest = startWidth
    grip.setPointerCapture?.(event.pointerId)

    const onMove = (e) => {
      latest = clampKpiWidth(startWidth + e.clientX - startX) ?? startWidth
      setResizing({ id: kpi.id, width: latest })
    }
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onUp)
      setResizing(null)
      if (Math.round(latest) !== Math.round(startWidth)) onResize?.(kpi.id, latest)
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
  }

  /**
   * Widen a box just enough that nothing in it is clipped.
   *
   * Reads the overflow straight off the DOM — `scrollWidth` exceeds
   * `clientWidth` by exactly the clipped amount — so it fits the figure that is
   * on screen now. It only ever widens: a box already showing everything has no
   * measurable "natural" width to shrink to, and resetting is what Home is for.
   */
  const fitToContent = (kpi, cell) => {
    const clipped = [...cell.querySelectorAll('[data-kpi-text]')]
      .map((el) => el.scrollWidth - el.clientWidth)
    const extra = Math.max(0, ...clipped)
    if (extra <= 0) return
    // +2: scrollWidth is rounded, and a figure sitting exactly on the edge
    // would otherwise still get its last pixel clipped.
    onResize?.(kpi.id, cell.getBoundingClientRect().width + extra + 2)
  }

  const onGripKeyDown = (event, kpi) => {
    const cell = event.currentTarget.parentElement
    if (event.key === 'Home') {
      event.preventDefault()
      onResize?.(kpi.id, null)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const current = cell.getBoundingClientRect().width
    onResize?.(kpi.id, current + (event.key === 'ArrowRight' ? step : -step))
  }

  const body = kpis.map((kpi, index) => {
    const tag = tags[kpi.id]
    const bound = kpiIsBound(kpi)
    const unit = kpi.binding?.unit || ''
    // Three states, and the difference between the last two is the whole point
    // of the footer. A box that has *never* answered has no last known figure
    // to stand behind, so calling that "last known" would tell an operator the
    // number above it was once real. `formatValue` prints an em-dash either
    // way; only the caption can separate them.
    const waiting = bound && !tag
    const stale = bound && tag?.status === 'stale'
    const label = bilingual(kpi.label, kpi.labelEn)
    const shown = bound ? formatValue(tag) : '—'

    const content = (
      <>
        <span className={styles.label} data-kpi-text>
          {label ?? <em className={styles.unnamed}>Unnamed</em>}
        </span>
        {/* The full figure is also the tooltip: a box that is too narrow clips
          * with an ellipsis, and hovering should never be the only way to learn
          * that the number ends in a different digit than it appears to. */}
        <span className={styles.value} data-kpi-text title={`${shown}${unit && bound ? ` ${unit}` : ''}`}>
          {shown}
          {unit && bound && <i className={styles.unit}>{unit}</i>}
        </span>
      </>
    )

    const classes = [
      styles.box,
      stale || waiting ? styles.boxStale : '',
      editing ? styles.boxEditable : '',
      dragOver === index ? styles.boxDragOver : '',
    ].filter(Boolean).join(' ')

    const width = resizing?.id === kpi.id ? resizing.width : kpi.width
    const cellClasses = [
      styles.cell,
      width ? styles.cellSized : '',
      resizing?.id === kpi.id ? styles.cellResizing : '',
    ].filter(Boolean).join(' ')
    const cellStyle = width ? { '--kpi-w': `${width}px` } : undefined

    if (!editing) {
      return (
        <div key={kpi.id} className={cellClasses} style={cellStyle}>
          <div className={classes}>{content}</div>
        </div>
      )
    }

    return (
      <div key={kpi.id} className={cellClasses} style={cellStyle}>
        <button
          type="button"
          className={classes}
          draggable
          aria-label={`Edit headline number ${index + 1}: ${kpi.label || kpi.labelEn || 'unnamed'}`}
          onClick={() => onEdit?.(kpi)}
          onDragStart={() => { dragFrom.current = index }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(index) }}
          onDragLeave={() => setDragOver((at) => (at === index ? null : at))}
          onDrop={(e) => {
            e.preventDefault()
            move(dragFrom.current, index)
            dragFrom.current = null
            setDragOver(null)
          }}
          onDragEnd={() => { dragFrom.current = null; setDragOver(null) }}
          // Dragging is not reachable from a keyboard, and reordering is the one
          // edit here that has no other route to it — a box can be re-bound from
          // its dialog, but its position cannot.
          onKeyDown={(e) => {
            if (!e.altKey) return
            if (e.key === 'ArrowLeft') { e.preventDefault(); move(index, index - 1) }
            if (e.key === 'ArrowRight') { e.preventDefault(); move(index, index + 1) }
          }}
        >
          {content}
        </button>
        <span
          className={styles.grip}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize headline number ${index + 1}`}
          aria-valuemin={KPI_MIN_WIDTH}
          aria-valuemax={KPI_MAX_WIDTH}
          aria-valuenow={kpi.width ?? undefined}
          aria-valuetext={kpi.width ? `${kpi.width} pixels` : 'automatic width'}
          title="Drag to resize · double-click to fit the figure · Home resets to automatic"
          tabIndex={0}
          onPointerDown={(e) => startResize(e, kpi)}
          onDoubleClick={(e) => fitToContent(kpi, e.currentTarget.parentElement)}
          onKeyDown={(e) => onGripKeyDown(e, kpi)}
        />
      </div>
    )
  })

  // With every box pinned there is no "auto" box left to absorb the rest of the
  // row, which would show the hairline colour as a coloured block. A filler in
  // the panel colour takes that space instead. (In edit mode the `+` slot does
  // the same job, so it is only needed when that is not on screen.)
  const addVisible = editing && kpis.length < KPI_LIMIT
  const needsFiller = kpis.length > 0 && kpis.every((kpi) => kpi.width) && !addVisible

  return (
    <section
      className={`${styles.strip} ${inBanner ? styles.stripInBanner : ''}`}
      aria-label="ตัวเลขหัวจอ / Headline numbers"
    >
      {body}
      {addVisible && (
        <button type="button" className={styles.add} onClick={onAdd}>
          <AddOutlined fontSize="small" />
          <span>Add number</span>
        </button>
      )}
      {needsFiller && <span className={styles.fill} aria-hidden="true" />}
    </section>
  )
}
