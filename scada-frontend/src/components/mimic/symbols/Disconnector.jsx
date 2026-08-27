import s from './symbols.module.css'

/**
 * Disconnector — isolator / knife switch. Unlike a breaker it has no square
 * contact box: the whole point of the symbol is that you can see the air gap.
 * The blade hinges open (`.slide`), which is how an isolator is proved safe.
 */
export default function Disconnector({ node, tag }) {
  const { w, h } = node
  const closed = tag?.state === 'closed'
  const cx = w / 2
  const hingeY = h * 0.74
  const contactY = h * 0.26

  return (
    <g className={closed ? '' : s.stopped}>
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={contactY} />
      <line className={s.body} x1={cx} y1={hingeY} x2={cx} y2={h} />

      {/* fixed contact + hinge pin */}
      <circle className={s.hairFill} cx={cx} cy={contactY} r={3} />
      <circle className={s.hairFill} cx={cx} cy={hingeY} r={3} />

      {/* The blade pivots about the hinge. `.slide` is transform-box: fill-box
          and a vertical line has a zero-width box, so a transparent rect pins
          it — bottom-centre of that box is the hinge pin. */}
      <g
        className={s.slide}
        style={{
          transformOrigin: '50% 100%',
          transform: closed ? 'rotate(0deg)' : 'rotate(-34deg)',
        }}
      >
        <rect
          x={cx - w * 0.2}
          y={contactY}
          width={w * 0.4}
          height={hingeY - contactY}
          fill="none"
          stroke="none"
        />
        <line
          className={s.accentStroke}
          x1={cx}
          y1={hingeY}
          x2={cx}
          y2={contactY}
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
        {closed ? 'closed' : 'isolated'}
      </text>
    </g>
  )
}
