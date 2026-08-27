import s from './symbols.module.css'

/**
 * Tank — vertical vessel with a live level fill. Used for both the
 * condensate tank and the steam drum; the label distinguishes them.
 *
 * On-change animation: the liquid rect's y/height are CSS-transitioned (see
 * `.liquid`), so a new level tweens instead of jumping.
 */
export default function Tank({ node, tag }) {
  const { w, h, id } = node
  const clipId = `mimic-clip-${id}`

  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const pct = tag?.value == null ? 0 : Math.min(1, Math.max(0, (tag.value - range[0]) / span))
  const fillH = h * pct

  return (
    <g>
      <clipPath id={clipId}>
        <rect x={0} y={0} width={w} height={h} rx={w * 0.16} />
      </clipPath>

      <rect className={s.body} x={0} y={0} width={w} height={h} rx={w * 0.16} />

      <g clipPath={`url(#${clipId})`}>
        <rect className={s.liquid} x={0} y={h - fillH} width={w} height={fillH} />
        <line
          className={s.liquidLine}
          x1={0}
          y1={h - fillH}
          x2={w}
          y2={h - fillH}
        />
      </g>

      {/* head seams — reads as a fabricated vessel rather than a rounded box */}
      <line className={s.hair} x1={0} y1={h * 0.13} x2={w} y2={h * 0.13} />
      <line className={s.hair} x1={0} y1={h * 0.87} x2={w} y2={h * 0.87} />

      {/* sight-glass ticks at 25 / 50 / 75 % */}
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          className={s.hair}
          x1={w - 14}
          y1={h * (1 - t)}
          x2={w - 4}
          y2={h * (1 - t)}
        />
      ))}

      <text className={s.label}
            x={w / 2}
            y={h + 20}
            textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}
          >
        {node.label}
      </text>
    </g>
  )
}
