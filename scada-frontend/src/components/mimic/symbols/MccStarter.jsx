import s from './symbols.module.css'

/**
 * MccStarter — one motor control centre bucket: contactor over overload over
 * outgoing terminals. This is the unit an electrician actually racks in and
 * pulls out, so it is drawn as the bucket rather than as three loose symbols.
 *
 * Running is read from the contactor being pulled in; a tripped overload is
 * the one condition that must be visible from across the room, so it takes
 * the critical stroke.
 */
export default function MccStarter({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const tripped = tag?.status === 'crit'
  const cx = w / 2

  const coilY = h * 0.24
  const olY = h * 0.56

  return (
    <g className={running ? '' : s.stopped}>
      {/* the bucket */}
      <rect className={s.bodyElev} x={0} y={0} width={w} height={h} rx={3} />
      <line className={s.hair} x1={0} y1={h * 0.14} x2={w} y2={h * 0.14} />

      {/* incoming stab */}
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={coilY - 12} />

      {/* contactor coil — filled when pulled in */}
      <rect
        className={s.body}
        x={cx - w * 0.2}
        y={coilY - 12}
        width={w * 0.4}
        height={24}
        rx={2}
        fill={running ? 'var(--accent)' : 'var(--bg-panel)'}
        opacity={running ? 0.85 : 1}
      />
      <line className={s.hair} x1={cx} y1={coilY + 12} x2={cx} y2={olY - 13} />

      {/* thermal overload — the zig-zag heater element */}
      <rect
        className={s.body}
        x={cx - w * 0.2}
        y={olY - 13}
        width={w * 0.4}
        height={26}
        rx={2}
        stroke={tripped ? 'var(--crit)' : undefined}
      />
      <path
        className={s.hair}
        d={`M ${cx - w * 0.11} ${olY - 7} l ${w * 0.07} 14 l ${w * 0.07} -14 l ${w * 0.07} 14`}
        stroke={tripped ? 'var(--crit)' : undefined}
      />

      <line className={s.body} x1={cx} y1={olY + 13} x2={cx} y2={h} />

      <text className={s.labelDim} x={cx} y={h * 0.105} textAnchor="middle">
        MCC
      </text>
      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={cx} y={h + 31} textAnchor="middle">
        {tripped ? 'tripped' : running ? 'running' : 'stopped'}
      </text>
    </g>
  )
}
