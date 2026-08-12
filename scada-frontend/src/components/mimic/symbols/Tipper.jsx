import s from './symbols.module.css'

/**
 * Tipper — the tipping unit that joins filter plugs to the tobacco rods with
 * a band of tipping paper. Drawn as the reel over the drum, because the reel
 * running out is the stoppage this machine is known for and an operator
 * scanning the mimic is looking for exactly that.
 */
export default function Tipper({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const reelCx = w * 0.24
  const reelCy = h * 0.26
  const reelR = h * 0.2

  const drumCx = w * 0.58
  const drumCy = h * 0.64
  const drumR = h * 0.28

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={h * 0.36} width={w} height={h * 0.58} rx={3} />

      {/* tipping-paper reel */}
      <circle className={s.body} cx={reelCx} cy={reelCy} r={reelR} />
      <g className={s.roll} key={tag?.pulse}>
        <circle className={s.hairFill} cx={reelCx} cy={reelCy} r={reelR * 0.28} />
      </g>
      {/* the web running down to the drum */}
      <line className={s.hair} x1={reelCx + reelR} y1={reelCy} x2={drumCx - drumR * 0.7} y2={drumCy - drumR * 0.6} />

      {/* fluted assembly drum */}
      <circle className={s.body} cx={drumCx} cy={drumCy} r={drumR} />
      <g className={s.spin}>
        <circle cx={drumCx} cy={drumCy} r={drumR} fill="none" stroke="none" />
        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a) => {
          const rad = (a * Math.PI) / 180
          return (
            <line
              key={a}
              className={s.hair}
              x1={drumCx + drumR * 0.74 * Math.cos(rad)}
              y1={drumCy + drumR * 0.74 * Math.sin(rad)}
              x2={drumCx + drumR * 0.96 * Math.cos(rad)}
              y2={drumCy + drumR * 0.96 * Math.sin(rad)}
            />
          )
        })}
      </g>

      {/* finished, tipped sticks leaving */}
      {[0.86, 0.93].map((k) => (
        <g key={k}>
          <rect className={s.body} x={w * k - w * 0.02} y={drumCy - 9} width={w * 0.04} height={18} rx={1} />
          <rect className={s.accentFill} x={w * k - w * 0.02} y={drumCy + 3} width={w * 0.04} height={6} opacity={0.6} />
        </g>
      ))}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
