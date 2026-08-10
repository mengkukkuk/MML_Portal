import s from './symbols.module.css'

/**
 * Actuator — motor-operated fuel damper. Carries both a discrete state
 * (open / closed) and an analog position, and the blade angle is driven by
 * the position: fully horizontal is wide open, vertical is shut.
 *
 * On-change animation: the blade sweeps to its new angle instead of
 * snapping (CSS transition on `.needle`).
 */
export default function Actuator({ node, tag }) {
  const { w, h } = node
  const closed = tag?.state === 'closed'
  const pct = tag?.value == null ? 0 : Math.min(1, Math.max(0, tag.value / 100))
  const angle = 90 * (1 - pct)

  const ductTop = h * 0.36
  const ductH = h - ductTop
  const cx = w / 2
  const cy = ductTop + ductH / 2
  const bladeR = Math.min(w, ductH) * 0.42

  return (
    <g className={closed ? s.stopped : ''}>
      {/* actuator head + stem */}
      <rect className={s.bodyElev} x={cx - w * 0.26} y={0} width={w * 0.52} height={h * 0.22} rx={2} />
      <line className={s.hair} x1={cx} y1={h * 0.22} x2={cx} y2={cy} />
      <text className={s.labelDim} x={cx} y={h * 0.15} textAnchor="middle">
        M
      </text>

      {/* duct walls — the blade sits between them */}
      <line className={s.body} x1={0} y1={ductTop} x2={w} y2={ductTop} />
      <line className={s.body} x1={0} y1={h} x2={w} y2={h} />

      <g className={s.needle} style={{ transform: `rotate(${angle}deg)` }}>
        <circle cx={cx} cy={cy} r={bladeR} fill="none" stroke="none" />
        <line x1={cx - bladeR} y1={cy} x2={cx + bladeR} y2={cy} />
      </g>
      <circle className={s.hairFill} cx={cx} cy={cy} r={3} />

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
