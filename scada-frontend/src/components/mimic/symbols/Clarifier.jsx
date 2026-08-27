import s from './symbols.module.css'

/**
 * Clarifier — circular settling tank seen in plan, which is how clarifiers are
 * always drawn: the rake sweep is the process, and an elevation would hide it.
 * The rake turns slowly (`.spinSlow`) because a clarifier rake genuinely does
 * — a fast sweep would resuspend the sludge it is there to collect.
 */
export default function Clarifier({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 3

  return (
    <g className={running ? '' : s.stopped}>
      <circle className={s.body} cx={cx} cy={cy} r={r} />
      {/* launder channel at the rim — the weir the clarified water leaves over */}
      <circle className={s.hair} cx={cx} cy={cy} r={r * 0.86} fill="none" />

      <circle className={s.liquid} cx={cx} cy={cy} r={r * 0.86} />

      {/* centre well */}
      <circle className={s.bodyElev} cx={cx} cy={cy} r={r * 0.2} />

      <g className={s.spinSlow}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="none" />
        {[0, 180].map((a) => {
          const rad = (a * Math.PI) / 180
          return (
            <g key={a}>
              <line
                className={s.accentStroke}
                x1={cx}
                y1={cy}
                x2={cx + r * 0.84 * Math.cos(rad)}
                y2={cy + r * 0.84 * Math.sin(rad)}
              />
              {/* scraper blades hang off the arm at an angle */}
              {[0.4, 0.62, 0.84].map((k) => (
                <line
                  key={k}
                  className={s.hair}
                  x1={cx + r * k * Math.cos(rad)}
                  y1={cy + r * k * Math.sin(rad)}
                  x2={cx + r * k * Math.cos(rad) - r * 0.14 * Math.sin(rad)}
                  y2={cy + r * k * Math.sin(rad) + r * 0.14 * Math.cos(rad)}
                />
              ))}
            </g>
          )
        })}
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
    </g>
  )
}
