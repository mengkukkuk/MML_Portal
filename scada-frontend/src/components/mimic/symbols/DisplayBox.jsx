import { formatValue, isNumeric, stateColor, statusColor } from '../tagStatus'
import useValueTransition from '../useValueTransition'
import s from './symbols.module.css'

const CHAR_W = 0.6

/**
 * DisplayBox — a bound column, printed. The plain-text counterpart to the
 * dials: no scale, no needle, no implied range, just what the column says.
 *
 * ## Text, from a numeric column
 *
 * `/api/schema/latest` types its value as a float, so the way a column becomes a
 * *word* is `state.map` in the binding dialog — 0 → IDLE, 1 → RUN, 2 → FAULT.
 * When a map is set this box prints the word; otherwise it prints the formatted
 * number and its unit. One symbol covers both because to an operator they are
 * the same question: what does this column currently say.
 *
 * ## The notifier
 *
 * A pip in the top-right corner, and nothing else. It is the add-on, so it stays
 * an add-on: the box does not flash, resize or change its lettering when a
 * reading goes off normal, because the text is what people came to read. A
 * stale box gets a hollow pip rather than a coloured one — "we have not heard
 * from this" is not a plant condition and must not be drawn as one.
 */
export default function DisplayBox({ node, tag }) {
  const { w, h } = node
  const { pulse } = useValueTransition(tag)

  const status = tag?.status ?? 'stale'
  const stale = !tag || status === 'stale'
  // A mapped state is the whole point of the symbol, so it wins over the number
  // it was derived from — printing both would be the same fact twice.
  const mapped = tag?.state ? String(tag.state).toUpperCase() : null
  const text = mapped ?? (isNumeric(tag?.value) ? formatValue(tag) : '––')
  const unit = mapped ? '' : (tag?.unit ?? '')

  const pad = Math.min(9, w * 0.06)
  const capY = h * 0.3
  const bodyH = h - capY

  const size = Math.min(bodyH * 0.54, (w - pad * 2) / ((text.length + unit.length * 0.8) * CHAR_W))
  const baseline = capY + bodyH / 2 + size * 0.35

  const pipR = Math.min(5, h * 0.09)
  const pipColor = stateColor(tag?.state) ?? statusColor(status)

  const statusClass = status === 'crit' ? s.statusCrit : status === 'warn' ? s.statusWarn : ''

  return (
    <g className={statusClass}>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={3} />
      <line className={s.hair} x1={0} y1={capY} x2={w} y2={capY} />

      <text className={s.labelDim} x={pad} y={capY - 7}>
        {tag?.id ?? node.tagId ?? node.label}
      </text>

      {/* The notifier. Hollow while stale, so a silent source never reads as a
          healthy green one. */}
      <circle
        className={s.pip}
        cx={w - pad - pipR}
        cy={capY / 2 - 1}
        r={pipR}
        fill={stale ? 'none' : pipColor}
        stroke={stale ? 'var(--fg-dim)' : pipColor}
      />

      <text
        key={pulse}
        className={`${s.boxValue} ${s.roll}`}
        x={w / 2}
        y={baseline}
        textAnchor="middle"
        style={{ fontSize: `${size}px`, fill: mapped ? pipColor : undefined }}
      >
        {text}
        {unit && <tspan className={s.counterUnit} dx={size * 0.24}>{unit}</tspan>}
      </text>

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
