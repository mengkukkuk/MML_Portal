import s from './symbols.module.css'

/**
 * HeatExchanger — shell-and-tube economiser. The serpentine tube bundle
 * carries marching dashes while feedwater is moving, which is what tells an
 * operator the unit is in service rather than bypassed.
 */
export default function HeatExchanger({ node, tag }) {
  const { w, h } = node
  const idle = tag?.value != null && tag.value <= 0

  const pad = w * 0.12
  const rows = 4
  const step = (h - pad * 2) / (rows - 1)
  let d = `M ${pad} ${pad}`
  for (let i = 0; i < rows - 1; i += 1) {
    const y = pad + step * i
    const y2 = y + step
    const rightward = i % 2 === 0
    d += rightward
      ? ` H ${w - pad} A ${step / 2} ${step / 2} 0 0 1 ${w - pad} ${y2} H ${pad}`
      : ` A ${step / 2} ${step / 2} 0 0 0 ${pad} ${y2}`
  }

  return (
    <g className={idle ? s.stopped : ''}>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={4} />
      <line className={s.hair} x1={w * 0.18} y1={0} x2={w * 0.18} y2={h} />
      <line className={s.hair} x1={w * 0.82} y1={0} x2={w * 0.82} y2={h} />
      <path className={`${s.accentStroke} ${s.march}`} d={d} />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
