import s from './symbols.module.css'

/**
 * Blower — aeration blower for an activated-sludge basin. Drawn as the volute
 * it is, with a tangential discharge rising from the casing: air leaves the
 * top of a blower, and a symbol that discharges sideways would be read as a
 * water pump.
 */
export default function Blower({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const cx = w * 0.42
  const cy = h * 0.5
  const r = Math.min(w * 0.3, h * 0.36)

  return (
    <g className={running ? '' : s.stopped}>
      {/* volute casing — an offset spiral, wider on the discharge side */}
      <circle className={s.body} cx={cx} cy={cy} r={r} />
      <path
        className={s.body}
        d={`M ${cx + r * 0.72} ${cy - r * 0.7}
            L ${w * 0.86} ${cy - r * 0.7}
            L ${w * 0.86} ${cy + r * 0.2}
            L ${cx + r * 0.95} ${cy + r * 0.2} Z`}
      />

      {/* suction filter box */}
      <rect className={s.bodyElev} x={0} y={cy - r * 0.5} width={w * 0.14} height={r} rx={2} />

      <g className={s.spin}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="none" />
        {[0, 60, 120, 180, 240, 300].map((a) => {
          const rad = (a * Math.PI) / 180
          return (
            <line
              key={a}
              className={s.hair}
              x1={cx + r * 0.25 * Math.cos(rad)}
              y1={cy + r * 0.25 * Math.sin(rad)}
              x2={cx + r * 0.78 * Math.cos(rad)}
              y2={cy + r * 0.78 * Math.sin(rad)}
            />
          )
        })}
        <circle className={s.accentFill} cx={cx} cy={cy} r={3} />
      </g>

      {/* baseplate */}
      <rect className={s.bodyElev} x={w * 0.1} y={h * 0.88} width={w * 0.7} height={h * 0.1} rx={2} />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle">
        {running ? 'aerating' : 'stopped'}
      </text>
    </g>
  )
}
