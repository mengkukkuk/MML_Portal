import s from './symbols.module.css'

/**
 * DosingPump — metering / diaphragm pump on a chemical line. It does not
 * rotate, it strokes, so it gets `.recip` rather than `.spin`: on a water
 * plant the difference between a centrifugal transfer pump and a positive-
 * displacement doser is the difference between moving water and controlling
 * a reaction, and the symbol should not blur the two.
 */
export default function DosingPump({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const headY = h * 0.34
  const headR = w * 0.26
  const cx = w * 0.42

  return (
    <g className={running ? '' : s.stopped}>
      {/* drive body */}
      <rect className={s.bodyElev} x={w * 0.04} y={headY - h * 0.16} width={w * 0.4} height={h * 0.32} rx={3} />

      {/* pump head */}
      <circle className={s.body} cx={cx + headR * 1.3} cy={headY} r={headR} />

      {/* the plunger — the moving part */}
      <g className={s.recip}>
        <rect
          className={s.accentFill}
          x={w * 0.42}
          y={headY - 4}
          width={w * 0.2}
          height={8}
          rx={2}
        />
      </g>

      {/* chemical tank below, with its level */}
      <rect className={s.body} x={w * 0.12} y={h * 0.58} width={w * 0.76} height={h * 0.42} rx={2} />
      <rect className={s.liquid} x={w * 0.14} y={h * 0.72} width={w * 0.72} height={h * 0.26} />

      {/* suction lance into the tank */}
      <line className={s.hair} x1={cx + headR * 1.3} y1={headY + headR} x2={cx + headR * 1.3} y2={h * 0.88} />

      <text
        className={s.label}
        x={w / 2}
        y={h + 18}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {running ? 'dosing' : 'idle'}
      </text>
    </g>
  )
}
