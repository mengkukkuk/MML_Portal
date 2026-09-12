import { useRef, useState } from 'react'
import AddOutlined from '@mui/icons-material/AddOutlined'
import { formatValue } from '@/components/mimic/tagStatus'
import { KPI_LIMIT, kpiIsBound } from './kpiBoxes'
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

export default function KpiStrip({
  kpis = [], tags = {}, editing = false, inBanner = false, onEdit, onAdd, onReorder,
}) {
  const dragFrom = useRef(null)
  const [dragOver, setDragOver] = useState(null)

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

    const content = (
      <>
        <span className={styles.label}>
          {label ?? <em className={styles.unnamed}>Unnamed</em>}
        </span>
        <span className={styles.value}>
          {bound ? formatValue(tag) : '—'}
          {unit && bound && <i className={styles.unit}>{unit}</i>}
        </span>
        <span className={styles.foot}>
          {!bound ? 'ยังไม่ได้เลือกค่า / No reading selected'
            : waiting ? 'กำลังอ่าน / Waiting for a reading'
              : stale ? 'ข้อมูลเดิม / Last known'
                : kpi.binding?.value_col}
        </span>
      </>
    )

    const classes = [
      styles.box,
      stale || waiting ? styles.boxStale : '',
      editing ? styles.boxEditable : '',
      dragOver === index ? styles.boxDragOver : '',
    ].filter(Boolean).join(' ')

    if (!editing) return <div key={kpi.id} className={classes}>{content}</div>

    return (
      <button
        key={kpi.id}
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
    )
  })

  return (
    <section
      className={`${styles.strip} ${inBanner ? styles.stripInBanner : ''}`}
      aria-label="ตัวเลขหัวจอ / Headline numbers"
    >
      {body}
      {editing && kpis.length < KPI_LIMIT && (
        <button type="button" className={styles.add} onClick={onAdd}>
          <AddOutlined fontSize="small" />
          <span>Add number</span>
        </button>
      )}
    </section>
  )
}
