import s from './symbols.module.css'

/**
 * TobaccoFeed — the tobacco feeder that supplies the maker. A hopper over a
 * carding drum: the drum meters the shower, and the hopper level is the
 * reading a line operator watches, because a feeder running empty stops the
 * maker within seconds.
 */
export default function TobaccoFeed({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const pct = tag?.value == null
    ? 0.6
    : Math.min(1, Math.max(0, (tag.value - range[0]) / span))

  const hopTop = 0
  const hopBot = h * 0.56
  const drumCy = h * 0.76
  const drumR = w * 0.22

  const fillTop = hopBot - pct * (hopBot - hopTop)
  // The hopper tapers, so the fill has to taper with it or the level reads wrong.
  const halfAt = (y) => (w * 0.5) * (1 - 0.62 * ((y - hopTop) / (hopBot - hopTop)))

  return (
    <g className={running ? '' : s.stopped}>
      {/* tapered hopper */}
      <path
        className={s.body}
        d={`M 0 ${hopTop} L ${w} ${hopTop} L ${w / 2 + halfAt(hopBot)} ${hopBot} L ${w / 2 - halfAt(hopBot)} ${hopBot} Z`}
      />
      <path
        className={s.liquid}
        d={`M ${w / 2 - halfAt(fillTop)} ${fillTop}
            L ${w / 2 + halfAt(fillTop)} ${fillTop}
            L ${w / 2 + halfAt(hopBot)} ${hopBot}
            L ${w / 2 - halfAt(hopBot)} ${hopBot} Z`}
      />

      {/* carding drum */}
      <circle className={s.body} cx={w / 2} cy={drumCy} r={drumR} />
      <g className={s.spin}>
        <circle cx={w / 2} cy={drumCy} r={drumR} fill="none" stroke="none" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
          const rad = (a * Math.PI) / 180
          return (
            <line
              key={a}
              className={s.hair}
              x1={w / 2 + drumR * 0.45 * Math.cos(rad)}
              y1={drumCy + drumR * 0.45 * Math.sin(rad)}
              x2={w / 2 + drumR * 0.92 * Math.cos(rad)}
              y2={drumCy + drumR * 0.92 * Math.sin(rad)}
            />
          )
        })}
      </g>

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
