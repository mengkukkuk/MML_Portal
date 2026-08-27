import s from './symbols.module.css'

/**
 * Transformer — two-winding power transformer, drawn as IEC 60617 draws it:
 * two overlapping circles, one per winding. The overlap is the coupling, so
 * the symbol says "these two systems are joined but not connected".
 *
 * Loading is the reading worth carrying, so the winding fill tracks it.
 */
export default function Transformer({ node, tag }) {
  const { w, h } = node
  const r = Math.min(w * 0.42, h * 0.3)
  const cx = w / 2
  const topCy = h * 0.34
  const botCy = topCy + r * 1.25

  return (
    <g>
      {/* HV / LV terminals */}
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={topCy - r} />
      <line className={s.body} x1={cx} y1={botCy + r} x2={cx} y2={h} />

      <circle className={s.body} cx={cx} cy={topCy} r={r} />
      <circle className={s.body} cx={cx} cy={botCy} r={r} fill="none" />

      {/* winding turns — three arcs per coil, the drawing convention for a
          wound core rather than an air-cored coupling */}
      {[topCy, botCy].map((cy) => (
        <g key={cy}>
          {[-0.4, 0, 0.4].map((k) => (
            <path
              key={k}
              className={s.hair}
              d={`M ${cx - r * 0.5} ${cy + r * k} q ${r * 0.5} ${-r * 0.28} ${r} 0`}
            />
          ))}
        </g>
      ))}

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
