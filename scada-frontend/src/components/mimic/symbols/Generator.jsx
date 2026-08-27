import s from './symbols.module.css'

/**
 * Generator — standby set: the IEC rotating-machine circle marked G, on a base
 * tank whose fill is the fuel left.
 *
 * The rotor spins while the set is running and freezes when it stops, which is
 * the whole point of a standby machine on a mimic — "is it turning" is the first
 * question after a mains failure.
 *
 * Fuel is drawn rather than printed. A standby generator's runtime is its fuel,
 * and a level an operator can see at a glance beats a number they have to
 * compare against a remembered capacity.
 */
export default function Generator({ node, tag }) {
  const { w, h, id } = node
  const clipId = `mimic-clip-${id}`
  const running = tag?.state === 'run'

  const r = Math.min(w * 0.34, h * 0.3)
  const cx = w / 2
  const cy = h * 0.36

  // Fuel rides on the same reading when there is only one: a generator bound to
  // a single column is far more often bound to its tank than to its rotor.
  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const pct = tag?.value == null ? 0.5 : Math.min(1, Math.max(0, (tag.value - range[0]) / span))

  const tankY = h * 0.74
  const tankH = h * 0.2
  const tankX = w * 0.12
  const tankW = w * 0.76
  const fillH = tankH * pct

  return (
    <g className={running ? '' : s.stopped}>
      <clipPath id={clipId}>
        <rect x={tankX} y={tankY} width={tankW} height={tankH} rx={2} />
      </clipPath>

      {/* the machine */}
      <circle className={s.body} cx={cx} cy={cy} r={r} />
      <text className={s.label} x={cx} y={cy + 5} textAnchor="middle">G</text>

      {/* rotor mark — the only way a circle reads as turning */}
      <g className={s.spinSlow}>
        <circle className={s.body} cx={cx} cy={cy} r={r} fill="none" stroke="none" />
        <line
          className={s.accentStroke}
          x1={cx}
          y1={cy - r * 0.72}
          x2={cx}
          y2={cy - r * 0.4}
          strokeLinecap="round"
        />
      </g>

      {/* mounting frame down to the base tank */}
      <line className={s.hair} x1={cx} y1={cy + r} x2={cx} y2={tankY} />

      <rect className={s.body} x={tankX} y={tankY} width={tankW} height={tankH} rx={2} />
      <g clipPath={`url(#${clipId})`}>
        <rect
          className={s.liquid}
          x={tankX}
          y={tankY + tankH - fillH}
          width={tankW}
          height={fillH}
        />
      </g>

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={cx} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {running ? 'running' : 'standby'}
      </text>
    </g>
  )
}
