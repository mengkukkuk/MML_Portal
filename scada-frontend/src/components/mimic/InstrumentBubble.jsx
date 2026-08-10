import { formatValue } from './mockPlant'
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
 *   tag               one entry from the plant snapshot's flat `tags` map
 */
export default function InstrumentBubble({ cx, cy, anchorX, anchorY, tag }) {
  const { pulse, dir, crossed } = useValueTransition(tag)
  if (!tag) return null

  const [fn, loop] = tag.id.split('-')
  const status = tag.status

  // Lead line stops at the circle's edge rather than at its centre.
  const dx = cx - anchorX
  const dy = cy - anchorY
  const dist = Math.hypot(dx, dy) || 1
  const edgeX = cx - (dx / dist) * R
  const edgeY = cy - (dy / dist) * R

  const ringTint = crossed && status === 'crit' ? s.ringCrit
    : crossed && status === 'warn' ? s.ringWarn
      : dir > 0 ? s.ringRise : s.ringFall

  const statusClass = status === 'crit' ? s.bubbleCrit : status === 'warn' ? s.bubbleWarn : ''

  return (
    <g className={statusClass}>
      <path className={s.bubbleLead} d={`M ${anchorX} ${anchorY} L ${edgeX} ${edgeY}`} />
      {/* key={pulse} is what makes this fire once per *displayed* change */}
      <circle key={pulse} className={`${s.ring} ${ringTint}`} cx={cx} cy={cy} r={R} />
      <circle className={s.bubbleFace} cx={cx} cy={cy} r={R} />
      <line className={s.bubbleSplit} x1={cx - R + 3} y1={cy - 6} x2={cx + R - 3} y2={cy - 6} />
      <text className={s.bubbleTag} x={cx} y={cy - 13}>
        {fn}
        {loop ? `\u2009${loop}` : ''}
      </text>
      <text key={`v${pulse}`} className={`${s.bubbleValue} ${s.roll}`} x={cx} y={cy + 12}>
        {formatValue(tag)}
      </text>
      {tag.unit && (
        <text className={s.bubbleUnit} x={cx} y={cy + 24}>
          {tag.unit}
        </text>
      )}
    </g>
  )
}
