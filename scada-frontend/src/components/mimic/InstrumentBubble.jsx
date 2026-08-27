import { formatValue } from './tagStatus'
import useValueTransition from './useValueTransition'
import s from './symbols/symbols.module.css'

const R = 34

/**
 * InstrumentBubble — an ISA-5.1 balloon that carries the live reading.
 *
 * The convention is a circle split by a hairline, function letters above the
 * loop number, tethered to its equipment by a dotted lead line. The one
 * deviation, and the page's signature, is that the lower half shows the live
 * value rather than the loop number: the drawing *is* the instrument, so the
 * mimic needs no floating value cards over the top of it.
 *
 * Props:
 *   cx, cy            bubble centre, logical units
 *   anchorX, anchorY  where on the equipment the lead line starts
 *   tag               one entry from the plant snapshot, or null when the
 *                     symbol has no datasource bound yet
 *   tagId             the loop id to print when there is no tag to read it off
 *   radius            circle radius, logical units — an admin's per-node
 *                     override (node.options.bubbleSize) or the default R.
 *                     Every offset below was hand-tuned around R=34, so the
 *                     whole glyph scales from that ratio rather than just the
 *                     circle growing around fixed-size text.
 */
export default function InstrumentBubble({
  cx, cy, anchorX, anchorY, tag, tagId = null, radius = R,
}) {
  const scale = radius / R
  const { pulse, dir, crossed } = useValueTransition(tag)

  // The loop id is free text an admin types into the binding dialog, not the
  // 'TT-202' shape the simulator's dictionary guaranteed. Split on the first
  // dash only, and fall back to printing the whole string as the function
  // letters — a balloon with a blank upper half reads as a drawing error.
  const label = tag?.id ?? tagId ?? ''
  const dash = label.indexOf('-')
  const fn = dash > 0 ? label.slice(0, dash) : label
  const loop = dash > 0 ? label.slice(dash + 1) : ''

  // An unbound symbol still gets its balloon: an uncommissioned loop is drawn
  // on a P&ID, just without a reading. Nothing at all would read as a symbol
  // that has no instrument rather than one waiting to be connected.
  if (!tag && !label) return null

  const status = tag?.status ?? 'stale'

  // Lead line stops at the circle's edge rather than at its centre.
  const dx = cx - anchorX
  const dy = cy - anchorY
  const dist = Math.hypot(dx, dy) || 1
  const edgeX = cx - (dx / dist) * radius
  const edgeY = cy - (dy / dist) * radius

  const ringTint = crossed && status === 'crit' ? s.ringCrit
    : crossed && status === 'warn' ? s.ringWarn
      : dir > 0 ? s.ringRise : s.ringFall

  const statusClass = status === 'crit' ? s.bubbleCrit : status === 'warn' ? s.bubbleWarn : ''

  return (
    <g className={`${statusClass} ${tag ? '' : s.bubbleUnbound}`}>
      <path className={s.bubbleLead} d={`M ${anchorX} ${anchorY} L ${edgeX} ${edgeY}`} />
      {/* key={pulse} is what makes this fire once per *displayed* change */}
      <circle key={pulse} className={`${s.ring} ${ringTint}`} cx={cx} cy={cy} r={radius} />
      <circle className={s.bubbleFace} cx={cx} cy={cy} r={radius} />
      <line
        className={s.bubbleSplit}
        x1={cx - radius + 3 * scale}
        y1={cy - 6 * scale}
        x2={cx + radius - 3 * scale}
        y2={cy - 6 * scale}
      />
      <text className={s.bubbleTag} x={cx} y={cy - 13 * scale} style={{ fontSize: 11 * scale }}>
        {fn}
        {loop ? `\u2009${loop}` : ''}
      </text>
      <text
        key={`v${pulse}`}
        className={`${s.bubbleValue} ${s.roll}`}
        x={cx}
        y={cy + 12 * scale}
        style={{ fontSize: 15 * scale }}
      >
        {formatValue(tag)}
      </text>
      {tag?.unit && (
        <text className={s.bubbleUnit} x={cx} y={cy + 24 * scale} style={{ fontSize: 9 * scale }}>
          {tag.unit}
        </text>
      )}
    </g>
  )
}
