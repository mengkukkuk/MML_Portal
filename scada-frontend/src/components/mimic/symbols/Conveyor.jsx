import s from './symbols.module.css'

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/* The belt's period at a standstill and at full rate, in seconds. A stopped
 * drive is frozen rather than slowed, so the slow end is "barely moving", not
 * "not moving": a belt creeping at 0.1 m/s is a fault worth seeing. */
const TICK_SLOW = 2.6
const TICK_FAST = 0.85

/**
 * Conveyor — fuel belt between two pulleys. Chevrons travel along the belt and
 * product rides on top of it while it runs; the pulleys turn with it. All of
 * it stops together when the drive stops, which is the point: one frozen
 * symbol, not a frozen page.
 *
 * The speed reading sets the pace. A belt is one of the few symbols where the
 * number and the motion say the same thing, and letting every conveyor run at
 * one hard-coded rate throws that away — a drive limping at a fifth of its
 * setpoint would look exactly like a healthy one.
 */
export default function Conveyor({ node, tag }) {
  const { w, h, id } = node
  const running = tag?.state === 'run'
  const clipId = `mimic-clip-${id}`
  const loadClipId = `mimic-load-${id}`

  const r = h * 0.34
  const cy = h * 0.5
  const chevrons = Math.ceil(w / 24) + 2
  const loads = Math.ceil(w / 48) + 2

  // Product sits on the upper belt line, in whatever headroom the symbol has
  // above it — the box is the operator's, not ours, so this fits rather than
  // assuming.
  const loadH = Math.min(16, Math.max(5, cy - r - 1))
  const loadY = cy - r - loadH

  const lo = tag?.range?.[0]
  const hi = tag?.range?.[1]
  const rate = tag?.value == null || !Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo
    ? null
    : clamp01((tag.value - lo) / (hi - lo))
  const tick = rate == null ? 1.6 : TICK_SLOW - rate * (TICK_SLOW - TICK_FAST)

  return (
    <g
      className={running ? '' : s.stopped}
      style={{ '--mimic-belt-tick': `${tick.toFixed(2)}s`, '--mimic-spin-tick': `${tick.toFixed(2)}s` }}
    >
      <clipPath id={clipId}>
        <rect x={r} y={cy - r} width={w - r * 2} height={r * 2} />
      </clipPath>
      <clipPath id={loadClipId}>
        <rect x={r} y={loadY - 1} width={w - r * 2} height={loadH + 1} />
      </clipPath>

      <line className={s.body} x1={r} y1={cy - r} x2={w - r} y2={cy - r} />
      <line className={s.body} x1={r} y1={cy + r} x2={w - r} y2={cy + r} />

      <g clipPath={`url(#${clipId})`}>
        <g className={s.belt}>
          {Array.from({ length: chevrons }, (_, i) => {
            const x = r - 24 + i * 24
            return (
              <path
                key={i}
                className={s.hair}
                d={`M ${x} ${cy - r * 0.6} L ${x + 9} ${cy} L ${x} ${cy + r * 0.6}`}
              />
            )
          })}
        </g>
      </g>

      <g clipPath={`url(#${loadClipId})`}>
        <g className={s.load}>
          {Array.from({ length: loads }, (_, i) => (
            <rect
              key={i}
              className={s.bodyElev}
              x={r - 48 + i * 48}
              y={loadY}
              width={18}
              height={loadH}
              rx={2}
            />
          ))}
        </g>
      </g>

      {[r, w - r].map((cx) => (
        <g key={cx}>
          <circle className={s.bodyElev} cx={cx} cy={cy} r={r} />
          <g className={s.spin}>
            <line className={s.hair} x1={cx - r * 0.7} y1={cy} x2={cx + r * 0.7} y2={cy} />
          </g>
        </g>
      ))}

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
