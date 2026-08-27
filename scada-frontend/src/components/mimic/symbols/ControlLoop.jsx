import s from './symbols.module.css'

/**
 * ControlLoop — a shared-display control function, drawn ISA-5.1 style: the
 * balloon inside a square. The square is not decoration — it is what tells a
 * reader the function is accessible from the control room rather than mounted
 * out in the field, which is the whole distinction the symbol exists to make.
 *
 * The setpoint deviation is the reading that matters, so the face carries the
 * process value with the mode beneath it.
 */
export default function ControlLoop({ node, tag }) {
  const { w, h } = node
  const auto = tag?.state !== 'stop'
  const value = tag?.display ?? '––'

  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.34

  return (
    <g>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={2} />
      <circle className={s.body} cx={cx} cy={cy} r={r} fill="var(--bg-app)" />
      <line className={s.hair} x1={cx - r} y1={cy} x2={cx + r} y2={cy} />

      <text className={s.bubbleTag} x={cx} y={cy - 5}>
        {node.tagId || 'XIC'}
      </text>
      <text className={s.bubbleValue} x={cx} y={cy + 15}>
        {value}
      </text>

      <text className={s.labelDim} x={cx} y={h - 6} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {auto ? 'auto' : 'manual'}
      </text>
      <text
        className={s.label}
        x={cx}
        y={h + 18}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
    </g>
  )
}
