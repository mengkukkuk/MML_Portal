import s from './symbols.module.css'

const LAMPS = [
  { state: 'red', color: 'var(--crit)' },
  { state: 'amber', color: 'var(--warn)' },
  { state: 'green', color: 'var(--ok)' },
]

/**
 * StackLight — the plant beacon. Mirrors the worst live status anywhere on
 * the skid (derived in mockPlant.js, never here). Red and amber blink;
 * green sits steady, because a blinking "everything is fine" trains people
 * to ignore blinking.
 */
export default function StackLight({ node, tag }) {
  const { w, h } = node
  const active = tag?.state ?? 'green'
  const lampH = (h - 12) / LAMPS.length

  return (
    <g>
      {LAMPS.map((lamp, i) => {
        const lit = lamp.state === active
        const y = i * lampH
        return (
          <g key={lamp.state} className={lit && lamp.state !== 'green' ? '' : s.stopped}>
            <rect
              className={s.body}
              x={0}
              y={y}
              width={w}
              height={lampH}
              rx={3}
              fill={lit ? lamp.color : 'var(--bg-panel)'}
              opacity={lit ? 1 : 0.5}
            />
            {lit && lamp.state !== 'green' && (
              <rect
                className={s.beacon}
                x={0}
                y={y}
                width={w}
                height={lampH}
                rx={3}
                fill={lamp.color}
              />
            )}
          </g>
        )
      })}
      <rect className={s.bodyElev} x={-4} y={h - 12} width={w + 8} height={12} rx={2} />
      <text
        className={s.label}
        x={w / 2}
        y={h + 20}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
    </g>
  )
}
