import s from './symbols.module.css'

/**
 * Valve — globe/control valve drawn as the P&ID bowtie with a diaphragm
 * actuator above it. The bowtie fills from the centre outwards in proportion
 * to the valve's commanded position, so a throttling valve reads at a glance.
 */
export default function Valve({ node, tag }) {
  const { w, h, id } = node
  const clipId = `mimic-clip-${id}`

  const bodyTop = h * 0.34
  const bodyH = h - bodyTop
  const cy = bodyTop + bodyH / 2
  const cx = w / 2

  const pct = tag?.value == null ? 0 : Math.min(1, Math.max(0, tag.value / 100))
  const openW = w * pct
  const closed = tag?.state === 'closed'

  const bowtie = `M 0 ${bodyTop} L 0 ${h} L ${w} ${bodyTop} L ${w} ${h} Z`

  return (
    <g className={closed ? s.stopped : ''}>
      {/* diaphragm actuator + stem */}
      <line className={s.hair} x1={cx} y1={h * 0.14} x2={cx} y2={cy} />
      <path
        className={s.bodyElev}
        d={`M ${cx - w * 0.24} ${h * 0.14} A ${w * 0.24} ${h * 0.14} 0 0 1 ${cx + w * 0.24} ${h * 0.14} Z`}
      />
      <line className={s.hair} x1={cx - w * 0.24} y1={h * 0.14} x2={cx + w * 0.24} y2={h * 0.14} />

      <clipPath id={clipId}>
        <rect x={cx - openW / 2} y={0} width={openW} height={h} />
      </clipPath>
      <path className={s.body} d={bowtie} />
      <path className={s.accentFill} d={bowtie} clipPath={`url(#${clipId})`} opacity={0.35} />
      <path className={s.body} d={bowtie} fill="none" />

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
