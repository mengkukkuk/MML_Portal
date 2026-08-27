import s from './symbols.module.css'

const SWEEP = 250 // total needle travel, degrees
const START = -125 // needle angle at range minimum

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1} ${y1}`
}

/**
 * Gauge — local dial indicator. The scale carries the tag's own warn and crit
 * bands, so the needle's position against colour says whether a value is
 * acceptable without reading the number.
 *
 * On-change animation: the needle sweeps to its new angle (CSS transition on
 * `.needle`) rather than teleporting.
 */
export default function Gauge({ node, tag }) {
  const { w, h } = node
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 4

  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const toDeg = (v) => START + SWEEP * Math.min(1, Math.max(0, (v - range[0]) / span))
  const angle = tag?.value == null ? START : toDeg(tag.value)

  const lim = tag?.limits ?? {}
  const bandR = r - 5

  return (
    <g>
      <circle className={s.body} cx={cx} cy={cy} r={r} />
      <path className={s.hair} d={arc(cx, cy, bandR, START, START + SWEEP)} />

      {lim.warnHi != null && lim.critHi != null && (
        <path
          className={`${s.dialBand} ${s.dialBandWarn}`}
          d={arc(cx, cy, bandR, toDeg(lim.warnHi), toDeg(lim.critHi))}
        />
      )}
      {lim.critHi != null && (
        <path
          className={`${s.dialBand} ${s.dialBandCrit}`}
          d={arc(cx, cy, bandR, toDeg(lim.critHi), START + SWEEP)}
        />
      )}
      {lim.warnLo != null && lim.critLo != null && (
        <path
          className={`${s.dialBand} ${s.dialBandWarn}`}
          d={arc(cx, cy, bandR, toDeg(lim.critLo), toDeg(lim.warnLo))}
        />
      )}
      {lim.critLo != null && (
        <path
          className={`${s.dialBand} ${s.dialBandCrit}`}
          d={arc(cx, cy, bandR, START, toDeg(lim.critLo))}
        />
      )}

      {/* Transparent full-radius circle pins the group's bbox to the dial, so
       * `transform-box: fill-box; transform-origin: center` pivots the needle
       * at the hub instead of at its own bounding box centre. */}
      <g className={s.needle} style={{ transform: `rotate(${angle}deg)` }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="none" />
        <line x1={cx} y1={cy + r * 0.16} x2={cx} y2={cy - r * 0.74} />
      </g>
      <circle className={s.hairFill} cx={cx} cy={cy} r={3.5} />

      <text
        className={s.label}
        x={cx}
        y={h + 18}
        textAnchor="middle"
        transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}
      >
        {node.label}
      </text>
    </g>
  )
}
