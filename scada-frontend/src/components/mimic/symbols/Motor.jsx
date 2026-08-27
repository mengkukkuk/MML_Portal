import s from './symbols.module.css'

/**
 * Motor — driver circle marked M, with a shaft and a rotating key-slot so
 * rotation is legible on a symbol that has no blades to watch.
 */
export default function Motor({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const r = Math.min(w, h) * 0.38
  const cx = w / 2
  const cy = h * 0.44

  return (
    <g className={running ? '' : s.stopped}>
      <line className={s.hair} x1={cx} y1={cy + r} x2={cx} y2={h} />
      <rect className={s.bodyElev} x={cx - w * 0.28} y={h - 8} width={w * 0.56} height={8} />
      <circle className={s.body} cx={cx} cy={cy} r={r} />

      <g className={s.spinSlow}>
        <line className={s.hair} x1={cx - r * 0.8} y1={cy} x2={cx + r * 0.8} y2={cy} />
        <circle className={s.accentFill} cx={cx} cy={cy - r * 0.62} r={3} />
      </g>

      <text className={s.readout} x={cx} y={cy + 5} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        M
      </text>
      <text className={s.label} x={cx} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
