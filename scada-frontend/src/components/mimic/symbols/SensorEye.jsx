import s from './symbols.module.css'

/**
 * SensorEye — through-beam photo eye watching the fuel belt. Discrete only:
 * `made` means the beam is broken by product, `clear` means it is not. The
 * beam pulses while searching and goes solid the moment it is made.
 */
export default function SensorEye({ node, tag }) {
  const { w, h } = node
  const made = tag?.state === 'made'
  const cy = h * 0.42

  return (
    <g>
      <rect className={s.body} x={0} y={cy - h * 0.2} width={w * 0.4} height={h * 0.4} rx={2} />
      <rect
        className={s.bodyElev}
        x={w * 0.86}
        y={cy - h * 0.16}
        width={w * 0.14}
        height={h * 0.32}
        rx={2}
      />
      <path
        className={made ? '' : s.beam}
        d={`M ${w * 0.4} ${cy - 4} L ${w * 0.86} ${cy - 4} L ${w * 0.86} ${cy + 4} L ${w * 0.4} ${cy + 4} Z`}
        fill={made ? 'var(--warn)' : 'var(--accent)'}
        opacity={made ? 0.9 : undefined}
      />
      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {made ? 'beam made' : 'beam clear'}
      </text>
    </g>
  )
}
