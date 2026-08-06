import s from './symbols.module.css'

/**
 * Conveyor — fuel belt between two pulleys. Chevrons travel along the belt
 * while it runs; the pulleys turn with it. Both stop together when the drive
 * stops, which is the point: one frozen symbol, not a frozen page.
 */
export default function Conveyor({ node, tag }) {
  const { w, h, id } = node
  const running = tag?.state === 'run'
  const clipId = `mimic-clip-${id}`

  const r = h * 0.34
  const cy = h * 0.5
  const chevrons = Math.ceil(w / 24) + 2

  return (
    <g className={running ? '' : s.stopped}>
      <clipPath id={clipId}>
        <rect x={r} y={cy - r} width={w - r * 2} height={r * 2} />
      </clipPath>

      <line className={s.body} x1={r} y1={cy - r} x2={w - r} y2={cy - r} />
      <line className={s.body} x1={r} y1={cy + r} x2={w - r} y2={cy + r} />

      <g clipPath={`url(#${clipId})`}>
        <g className={s.belt}>
          {Array.from({ length: chevrons }, (_, i) => {
            const x = r - 24 + i * 24
            return (
              <path
                key={i}
                className={s.hair}
                d={`M ${x} ${cy - r * 0.6} L ${x + 9} ${cy} L ${x} ${cy + r * 0.6}`}
              />
            )
          })}
        </g>
      </g>

      {[r, w - r].map((cx) => (
        <g key={cx}>
          <circle className={s.bodyElev} cx={cx} cy={cy} r={r} />
          <g className={s.spin}>
            <line className={s.hair} x1={cx - r * 0.7} y1={cy} x2={cx + r * 0.7} y2={cy} />
          </g>
        </g>
      ))}

      <text className={s.label} x={w / 2} y={h + 20} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
