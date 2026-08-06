import s from './symbols.module.css'

/**
 * FlowMeter — inline turbine meter: a spool piece with a rotor that turns
 * while there is flow. Frozen rotor + zero reading is how a dead meter looks
 * on a real board, so the two states are drawn to be told apart instantly.
 */
export default function FlowMeter({ node, tag }) {
  const { w, h } = node
  const flowing = tag?.value == null || tag.value > 0
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.34

  return (
    <g className={flowing ? '' : s.stopped}>
      <rect className={s.body} x={0} y={h * 0.22} width={w} height={h * 0.56} />
      <line className={s.hair} x1={w * 0.14} y1={h * 0.22} x2={w * 0.14} y2={h * 0.78} />
      <line className={s.hair} x1={w * 0.86} y1={h * 0.22} x2={w * 0.86} y2={h * 0.78} />
      <circle className={s.bodyElev} cx={cx} cy={cy} r={r} />

      <g className={s.spin}>
        <path
          className={s.accentStroke}
          d={`M ${cx - r * 0.7} ${cy} L ${cx + r * 0.7} ${cy} M ${cx} ${cy - r * 0.7} L ${cx} ${cy + r * 0.7}`}
        />
      </g>

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
