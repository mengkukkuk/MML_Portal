import s from './symbols.module.css'

/**
 * Breaker — circuit breaker, drawn IEC-style: a square contact box on the
 * conductor, filled when closed and clear when open. The moving contact
 * swings rather than jumps (`.slide`), so an operator watching the mimic sees
 * which way it went.
 */
export default function Breaker({ node, tag }) {
  const { w, h } = node
  const closed = tag?.state === 'closed' || tag?.state === 'run'
  const cx = w / 2
  const boxR = Math.min(w, h) * 0.3
  const cy = h / 2

  return (
    <g className={closed ? '' : s.stopped}>
      {/* conductor through the device */}
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={cy - boxR} />
      <line className={s.body} x1={cx} y1={cy + boxR} x2={cx} y2={h} />

      <rect
        className={s.body}
        x={cx - boxR}
        y={cy - boxR}
        width={boxR * 2}
        height={boxR * 2}
        fill={closed ? 'var(--accent)' : 'var(--bg-panel)'}
        opacity={closed ? 0.85 : 1}
      />

      {/* the moving contact: vertical through the box when closed, swung
          clear of it when open */}
      <g
        className={s.slide}
        style={{ transform: closed ? 'rotate(0deg)' : 'rotate(-38deg)' }}
      >
        <rect x={cx - boxR} y={cy - boxR} width={boxR * 2} height={boxR * 2} fill="none" stroke="none" />
        <line
          className={s.accentStroke}
          x1={cx}
          y1={cy + boxR * 0.85}
          x2={cx}
          y2={cy - boxR * 0.85}
          strokeLinecap="round"
        />
      </g>

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
      <text className={s.labelDim} x={cx} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {closed ? 'closed' : 'open'}
      </text>
    </g>
  )
}
