import {
  BUBBLE_BASE_RADIUS, bubbleGeometry, bubbleSplitInset, bubbleTextWidth,
} from './bubbleShape'
import { formatValue } from './tagStatus'
import useValueTransition from './useValueTransition'
import s from './symbols/symbols.module.css'

const R = BUBBLE_BASE_RADIUS

/**
 * InstrumentBubble — an ISA-5.1 balloon that carries the live reading.
 *
 * The convention is a circle split by a hairline, function letters above the
 * loop number. The one deviation, and the page's signature, is that the lower
 * half shows the live value rather than the loop number: the drawing *is* the
 * instrument, so the mimic needs no floating value cards over the top of it.
 *
 * There is no lead line back to the equipment. The balloon is placed beside its
 * symbol and moves with it, and a dotted tether across the drawing read as a
 * pipe or a signal wire to anyone who did not know the convention.
 *
 * Props:
 *   cx, cy            bubble centre, logical units
 *   tag               one entry from the plant snapshot, or null when the
 *                     symbol has no datasource bound yet
 *   tagId             the loop id to print when there is no tag to read it off
 *   radius            circle radius, logical units — an admin's per-node
 *                     override (node.options.bubbleSize) or the default R.
 *                     Every offset below was hand-tuned around R=34, so the
 *                     whole glyph scales from that ratio rather than just the
 *                     circle growing around fixed-size text.
 *   shape             'circle' (default) | 'square' | 'box' | 'pill' — see
 *                     bubbleShape.js. The size setting stays the radius for
 *                     every shape, so changing shape never changes how big the
 *                     text is.
 */

/** The outline as a circle or a rounded rectangle, sized from one radius. */
export function BubbleOutline({ shape = 'circle', cx, cy, radius = R, textWidth = 0, ...rest }) {
  if (shape === 'circle') return <circle cx={cx} cy={cy} r={radius} {...rest} />
  const { hw, hh, rx } = bubbleGeometry(shape, radius, textWidth)
  return <rect x={cx - hw} y={cy - hh} width={hw * 2} height={hh * 2} rx={rx} {...rest} />
}

export default function InstrumentBubble({
  cx, cy, tag, tagId = null, radius = R, shape = 'circle',
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

  const text = formatValue(tag)
  const textWidth = bubbleTextWidth(text, label)
  const { hw } = bubbleGeometry(shape, radius, textWidth)
  const inset = bubbleSplitInset(shape, scale)

  const ringTint = crossed && status === 'crit' ? s.ringCrit
    : crossed && status === 'warn' ? s.ringWarn
      : dir > 0 ? s.ringRise : s.ringFall

  const statusClass = status === 'crit' ? s.bubbleCrit : status === 'warn' ? s.bubbleWarn : ''

  return (
    <g className={`${statusClass} ${tag ? '' : s.bubbleUnbound}`}>
      {/* key={pulse} is what makes this fire once per *displayed* change */}
      <BubbleOutline
        key={pulse}
        shape={shape}
        className={`${s.ring} ${ringTint}`}
        cx={cx}
        cy={cy}
        radius={radius}
        textWidth={textWidth}
      />
      <BubbleOutline
        shape={shape}
        className={s.bubbleFace}
        cx={cx}
        cy={cy}
        radius={radius}
        textWidth={textWidth}
      />
      <line
        className={s.bubbleSplit}
        x1={cx - hw + inset}
        y1={cy - 6 * scale}
        x2={cx + hw - inset}
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
        {text}
      </text>
      {tag?.unit && (
        <text className={s.bubbleUnit} x={cx} y={cy + 24 * scale} style={{ fontSize: 9 * scale }}>
          {tag.unit}
        </text>
      )}
    </g>
  )
}
