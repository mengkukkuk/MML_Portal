import s from './symbols.module.css'

/**
 * Cellophaner — the overwrapper that films the pack and seals it. The film
 * reel and the heated sealing plates are both drawn because they are the two
 * things that stop the machine: the reel runs out, or the seals go cold.
 */
export default function Cellophaner({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const reelCx = w * 0.18
  const reelCy = h * 0.24
  const reelR = h * 0.18

  const packY = h * 0.52
  const packH = h * 0.28

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={h * 0.36} width={w} height={h * 0.56} rx={3} />

      {/* film reel */}
      <circle className={s.body} cx={reelCx} cy={reelCy} r={reelR} />
      <g className={s.spin}>
        <circle cx={reelCx} cy={reelCy} r={reelR} fill="none" stroke="none" />
        <line className={s.hair} x1={reelCx - reelR * 0.62} y1={reelCy} x2={reelCx + reelR * 0.62} y2={reelCy} />
      </g>
      {/* the film web drawn down over the pack path */}
      <path
        className={s.hair}
        d={`M ${reelCx + reelR} ${reelCy} Q ${w * 0.36} ${reelCy} ${w * 0.4} ${packY}`}
        fill="none"
      />

      {/* the pack travelling through, wrapped */}
      <rect className={s.body} x={w * 0.4} y={packY} width={w * 0.2} height={packH} rx={2} />
      <rect
        className={s.accentFill}
        x={w * 0.4}
        y={packY}
        width={w * 0.2}
        height={packH}
        rx={2}
        opacity={0.22}
      />

      {/* heated sealing plates closing on the wrap */}
      {[-1, 1].map((k) => (
        <rect
          key={k}
          className={s.body}
          x={w * 0.5 + k * w * 0.15 - w * 0.03}
          y={packY + packH * 0.25}
          width={w * 0.06}
          height={packH * 0.5}
          rx={1}
          fill={running ? 'var(--warn)' : 'var(--bg-panel)'}
          opacity={running ? 0.7 : 1}
        />
      ))}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
