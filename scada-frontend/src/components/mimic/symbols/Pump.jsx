import s from './symbols.module.css'

/**
 * Pump — centrifugal pump: circular casing on a plinth, with a three-vane
 * impeller that spins while the drive is running (steady-state animation).
 * A stopped pump keeps its geometry and simply freezes.
 */
export default function Pump({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const r = Math.min(w, h * 0.72) / 2
  const cx = w / 2
  const cy = h * 0.44

  return (
    <g className={running ? '' : s.stopped}>
      {/* plinth */}
      <path
        className={s.bodyElev}
        d={`M ${cx - r * 0.9} ${cy} L ${cx - r * 1.1} ${h} L ${cx + r * 1.1} ${h} L ${cx + r * 0.9} ${cy} Z`}
      />
      <circle className={s.body} cx={cx} cy={cy} r={r} />

      <g className={s.spin}>
        {[0, 120, 240].map((a) => (
          <path
            key={a}
            className={s.accentStroke}
            d={`M ${cx} ${cy} L ${cx + r * 0.68 * Math.cos((a * Math.PI) / 180)} ${cy + r * 0.68 * Math.sin((a * Math.PI) / 180)}`}
          />
        ))}
        <circle className={s.accentFill} cx={cx} cy={cy} r={2.5} />
      </g>

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={cx} y={h + 31} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {running ? 'running' : 'standby'}
      </text>
    </g>
  )
}
