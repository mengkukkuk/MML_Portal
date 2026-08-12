import s from './symbols.module.css'

/**
 * SafetyRelay — dual-channel safety relay. Both channels are drawn because
 * that redundancy *is* the device: a single-channel drawing would say
 * something untrue about the integrity level of the circuit.
 *
 * The safe state is de-energised, so an unbound or dead relay reads as
 * tripped rather than as healthy — the conservative default for a guard.
 */
export default function SafetyRelay({ node, tag }) {
  const { w, h } = node
  const healthy = tag?.state === 'closed' || tag?.state === 'run'

  const bodyH = h * 0.72
  const chY = [bodyH * 0.36, bodyH * 0.66]

  return (
    <g className={healthy ? '' : s.stopped}>
      <rect
        className={s.bodyElev}
        x={0}
        y={0}
        width={w}
        height={bodyH}
        rx={3}
        stroke={healthy ? undefined : 'var(--crit)'}
      />

      {chY.map((y, i) => (
        <g key={y}>
          <line className={s.hair} x1={w * 0.06} y1={y} x2={w * 0.34} y2={y} />
          {/* the contact: bridged when the guard circuit is made, swung clear
              when it is broken */}
          <line
            className={healthy ? s.accentStroke : s.hair}
            x1={w * 0.34}
            y1={y}
            x2={w * 0.66}
            y2={healthy ? y : y - 8}
            strokeLinecap="round"
            stroke={healthy ? undefined : 'var(--crit)'}
          />
          <line className={s.hair} x1={w * 0.66} y1={y} x2={w * 0.94} y2={y} />
          <circle className={s.hairFill} cx={w * 0.34} cy={y} r={2} />
          <circle className={s.hairFill} cx={w * 0.66} cy={y} r={2} />
          <text className={s.labelDim} x={w * 0.02} y={y - 6} textAnchor="start">
            CH{i + 1}
          </text>
        </g>
      ))}

      <text className={s.label} x={w / 2} y={h + 2} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 15} textAnchor="middle">
        {healthy ? 'guard made' : 'tripped'}
      </text>
    </g>
  )
}
