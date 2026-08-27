import { isNumeric } from '../tagStatus'
import useValueTransition from '../useValueTransition'
import s from './symbols.module.css'

/* Digits are laid out by hand rather than measured, because SVG text has no
 * intrinsic box and a mid-poll reflow would make the number jitter. Mono
 * tabular figures are all one advance, so counting characters is exact. */
const CHAR_W = 0.62

/**
 * Counter — a numeric totaliser. The one symbol on the sheet whose whole job is
 * the number itself, so it is sized to be read across a room and shows the
 * direction of the last change rather than only the current total.
 *
 * ## Decimals
 *
 * `binding.decimals` (0–6, set in the binding dialog) is the digit limit, and
 * it is applied unconditionally: a totaliser that shows three decimals on one
 * tick and none on the next is unreadable at a glance, and the *width* of the
 * number is how an operator spots a step change from the far side of a room.
 *
 * ## Non-numeric readings
 *
 * A counter that renders NaN as "NaN" looks like it is reading something. This
 * one refuses: the well goes to a fault legend naming what arrived, because the
 * repair is in the binding — a bad `expr`, a discrete-only column — and the
 * drawing is where the admin is standing when they find out.
 */
export default function Counter({ node, tag }) {
  const { w, h } = node
  const { pulse, dir } = useValueTransition(tag)

  const decimals = tag?.decimals ?? 0
  const numeric = isNumeric(tag?.value)
  // Distinguishes "nothing bound / nothing read yet", which is a normal state
  // on a drawing being built, from "something arrived and it was not a number",
  // which is a fault someone has to fix.
  const bound = tag?.value !== undefined && tag?.value !== null
  const fault = bound && !numeric

  const text = numeric ? tag.value.toFixed(decimals) : fault ? 'ERR' : '––'

  const pad = Math.min(10, w * 0.07)
  const wellX = pad
  const wellY = h * 0.22
  const wellW = w - pad * 2
  const wellH = h - wellY - pad

  // The unit sits inside the well, after the digits, so the two never drift
  // apart as the number grows or the symbol is resized.
  const unit = numeric ? (tag?.unit ?? '') : ''
  // Big enough to fill the well, capped so a wide box does not produce a number
  // taller than the plant it is reporting on.
  const size = Math.min(wellH * 0.62, (wellW * 0.9) / ((text.length + unit.length * 0.7) * CHAR_W))
  const baseline = wellY + wellH / 2 + size * 0.36

  const statusClass = fault || tag?.status === 'crit' ? s.statusCrit
    : tag?.status === 'warn' ? s.statusWarn : ''

  return (
    <g className={statusClass}>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={3} />
      <rect className={s.well} x={wellX} y={wellY} width={wellW} height={wellH} rx={2} />

      <text className={s.labelDim} x={wellX + 2} y={wellY - 5}>
        {tag?.id ?? node.tagId ?? 'total'}
      </text>

      {/* key={pulse} is what makes the roll fire once per *displayed* change —
          an unchanged tick re-mounts nothing and so animates nothing. */}
      <text
        key={pulse}
        className={`${s.counterValue} ${s.roll} ${fault ? s.counterFault : ''}`}
        x={wellX + wellW - 6}
        y={baseline}
        textAnchor="end"
        style={{ fontSize: `${size}px` }}
      >
        {text}
        {unit && <tspan className={s.counterUnit} dx={size * 0.22}>{unit}</tspan>}
      </text>

      {/* Which way it went, for the moment after it went. A totaliser that only
          ever counts up says nothing by rising; one that can fall says a great
          deal, and either way the caret is the only part of the symbol that
          reports the *change* rather than the state. */}
      {numeric && dir !== 0 && (
        <path
          key={`d${pulse}`}
          className={`${s.delta} ${dir > 0 ? s.deltaUp : s.deltaDown}`}
          d={dir > 0
            ? `M ${wellX + 5} ${baseline - 4} l 5 -8 l 5 8 Z`
            : `M ${wellX + 5} ${baseline - 12} l 5 8 l 5 -8 Z`}
        />
      )}

      {fault && (
        <text className={s.labelDim} x={w / 2} y={h - 4} textAnchor="middle">
          not a number
        </text>
      )}

      <text
        className={s.label}
        x={w / 2}
        y={h + 18}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
    </g>
  )
}
