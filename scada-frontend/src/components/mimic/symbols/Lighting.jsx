import s from './symbols.module.css'

/**
 * Lighting — the ring light a vision camera looks through. Drawn as a dashed
 * annulus around an open centre, the actual shape of the fixture, rather than
 * a generic lamp: a vision light illuminates through its own middle, it does
 * not shine off to one side the way a stack light does.
 */
export default function Lighting({ node, tag }) {
  const { w, h } = node
  const lit = tag?.state === 'run' || tag?.state === 'closed'

  const cx = w / 2
  const cy = h / 2
  const rOuter = Math.min(w, h) * 0.42
  const ringWidth = rOuter * 0.34

  return (
    <g>
      {/* soft wash, only while lit — the fixture illuminating its surroundings */}
      {lit && <circle cx={cx} cy={cy} r={rOuter * 1.5} fill="var(--ok)" opacity={0.08} />}

      <circle
        className={s.body}
        cx={cx}
        cy={cy}
        r={rOuter}
        fill="none"
        stroke={lit ? 'var(--ok)' : 'var(--fg-muted)'}
        strokeWidth={ringWidth}
        strokeDasharray={`${ringWidth * 0.7} ${ringWidth * 0.55}`}
        opacity={lit ? 0.95 : 0.4}
      />

      {/* the aperture the camera sees through */}
      <circle cx={cx} cy={cy} r={rOuter - ringWidth} fill="var(--bg-app)" stroke="var(--fg-dim)" strokeWidth={1} />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {lit ? 'lit' : 'off'}
      </text>
    </g>
  )
}
