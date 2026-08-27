import s from './symbols.module.css'

/**
 * RodMaker — the cigarette maker. The garniture is the heart of it: the
 * tobacco shower lands on a moving paper web, the web wraps it into a
 * continuous rod, and a cut-off chops the rod into sticks.
 *
 * So the symbol is drawn as that sequence left to right, and the band travels
 * (`.belt`) only while the maker is running. Rods per minute is the number the
 * whole line is judged on, so it is the reading this symbol carries.
 */
export default function RodMaker({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const clipId = `mimic-clip-${node.id}`

  const webY = h * 0.56
  const webH = h * 0.16
  const rollR = h * 0.16

  return (
    <g className={running ? '' : s.stopped}>
      {/* machine frame */}
      <rect className={s.bodyElev} x={0} y={h * 0.3} width={w} height={h * 0.62} rx={3} />

      {/* paper bobbin feeding the garniture */}
      <circle className={s.body} cx={w * 0.1} cy={webY} r={rollR} />
      <g className={s.spin}>
        <circle cx={w * 0.1} cy={webY} r={rollR} fill="none" stroke="none" />
        <line className={s.hair} x1={w * 0.1 - rollR * 0.7} y1={webY} x2={w * 0.1 + rollR * 0.7} y2={webY} />
      </g>

      {/* tobacco shower onto the web */}
      {[0.3, 0.36, 0.42].map((k) => (
        <line key={k} className={s.hair} x1={w * k} y1={h * 0.34} x2={w * k} y2={webY - webH / 2} />
      ))}

      {/* the garniture band */}
      <clipPath id={clipId}>
        <rect x={w * 0.2} y={webY - webH / 2} width={w * 0.58} height={webH} />
      </clipPath>
      <rect className={s.body} x={w * 0.2} y={webY - webH / 2} width={w * 0.58} height={webH} rx={2} />
      <g clipPath={`url(#${clipId})`}>
        <g className={s.belt}>
          {Array.from({ length: Math.ceil((w * 0.58) / 24) + 2 }, (_, i) => {
            const x = w * 0.2 - 24 + i * 24
            return (
              <line key={i} className={s.hair} x1={x} y1={webY - webH / 2} x2={x + 8} y2={webY + webH / 2} />
            )
          })}
        </g>
      </g>

      {/* cut-off head and the finished rods leaving */}
      <line className={s.accentStroke} x1={w * 0.8} y1={h * 0.36} x2={w * 0.8} y2={webY - webH / 2} />
      {[0.85, 0.91, 0.97].map((k) => (
        <rect
          key={k}
          className={s.body}
          x={w * k - w * 0.024}
          y={webY - webH * 0.34}
          width={w * 0.048}
          height={webH * 0.68}
          rx={1}
        />
      ))}

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
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {running ? 'making' : 'stopped'}
      </text>
    </g>
  )
}
