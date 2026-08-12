import s from './symbols.module.css'

/**
 * CapBank — power-factor correction bank. Three capacitor pairs in parallel,
 * which is how the stages are switched in on real gear, so the symbol counts
 * the stages rather than abstracting them to one.
 *
 * The bank is either in circuit or it is not; the reading it carries is the
 * resulting power factor.
 */
export default function CapBank({ node, tag }) {
  const { w, h } = node
  const inCircuit = tag?.state === 'closed' || tag?.state === 'run'
  const cx = w / 2
  const busY = h * 0.16
  const plateY = h * 0.52
  const gap = 8

  const stages = [-1, 0, 1]

  return (
    <g className={inCircuit ? '' : s.stopped}>
      {/* incomer + parallel bus */}
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={busY} />
      <line
        className={inCircuit ? s.accentStroke : s.body}
        x1={w * 0.16}
        y1={busY}
        x2={w * 0.84}
        y2={busY}
      />

      {stages.map((k) => {
        const x = cx + k * (w * 0.34)
        return (
          <g key={k}>
            <line className={s.hair} x1={x} y1={busY} x2={x} y2={plateY - gap} />
            <line className={s.body} x1={x - w * 0.11} y1={plateY - gap} x2={x + w * 0.11} y2={plateY - gap} />
            <line className={s.body} x1={x - w * 0.11} y1={plateY + gap} x2={x + w * 0.11} y2={plateY + gap} />
            <line className={s.hair} x1={x} y1={plateY + gap} x2={x} y2={h * 0.78} />
          </g>
        )
      })}

      {/* earth return */}
      <line className={s.hair} x1={w * 0.16} y1={h * 0.78} x2={w * 0.84} y2={h * 0.78} />
      <line className={s.hair} x1={cx} y1={h * 0.78} x2={cx} y2={h * 0.9} />

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={cx} y={h + 31} textAnchor="middle">
        {inCircuit ? 'in circuit' : 'out'}
      </text>
    </g>
  )
}
