import s from './symbols.module.css'

/**
 * Weir — V-notch measuring weir. The head over the notch *is* the flow
 * measurement, so the level line is not decoration here the way it is on a
 * tank: it is the instrument. It tweens with the reading (`.liquidLine`).
 */
export default function Weir({ node, tag }) {
  const { w, h } = node

  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const pct = tag?.value == null
    ? 0.35
    : Math.min(1, Math.max(0, (tag.value - range[0]) / span))

  const plateTop = h * 0.24
  const notchDepth = h * 0.4
  const notchHalf = w * 0.22
  const cx = w / 2
  const notchApex = plateTop + notchDepth

  // Head is measured from the notch apex upward.
  const levelY = notchApex - pct * notchDepth

  return (
    <g>
      {/* channel walls */}
      <line className={s.body} x1={0} y1={plateTop} x2={0} y2={h} />
      <line className={s.body} x1={w} y1={plateTop} x2={w} y2={h} />
      <line className={s.body} x1={0} y1={h} x2={w} y2={h} />

      {/* upstream water, clipped to the channel */}
      <rect
        className={s.liquid}
        x={1}
        y={levelY}
        width={w - 2}
        height={h - levelY}
      />

      {/* the weir plate with its V notch cut out */}
      <path
        className={s.body}
        d={`M ${w * 0.06} ${h}
            L ${w * 0.06} ${plateTop}
            L ${cx - notchHalf} ${plateTop}
            L ${cx} ${notchApex}
            L ${cx + notchHalf} ${plateTop}
            L ${w * 0.94} ${plateTop}
            L ${w * 0.94} ${h} Z`}
      />

      {/* the head line — the measurement itself */}
      <g className={s.liquidLine}>
        <line x1={w * 0.1} y1={levelY} x2={w * 0.9} y2={levelY} />
      </g>

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
