import s from './symbols.module.css'

/**
 * RejectStation — the quality gate that ejects a bad pack into the reject
 * chute. The arm is drawn *in* its current position and travels between them
 * (`.slide`): a reject station whose arm never appears to move gives no
 * confidence it is armed at all.
 *
 * A firing arm is the abnormal path, so it takes the warning stroke rather
 * than the accent — this is not a state you want to read as normal.
 */
export default function RejectStation({ node, tag }) {
  const { w, h } = node
  const rejecting = tag?.state === 'run' || tag?.state === 'made'

  const laneY = h * 0.42
  const laneH = h * 0.18
  const armX = w * 0.5

  return (
    <g>
      {/* pass lane */}
      <line className={s.body} x1={0} y1={laneY} x2={w} y2={laneY} />
      <line className={s.body} x1={0} y1={laneY + laneH} x2={w * 0.62} y2={laneY + laneH} />

      {/* reject chute dropping away below */}
      <path
        className={s.hair}
        d={`M ${w * 0.62} ${laneY + laneH} L ${w * 0.62} ${h * 0.94} L ${w * 0.94} ${h * 0.94}`}
        fill="none"
      />

      {/* the ejector arm: retracted across the lane, or extended into it */}
      <g
        className={s.slide}
        style={{ transform: rejecting ? `translateY(${laneH * 0.72}px)` : 'translateY(0px)' }}
      >
        <rect x={armX - 4} y={laneY - h * 0.24} width={8} height={h * 0.24} fill="none" stroke="none" />
        <rect
          className={s.body}
          x={armX - 5}
          y={laneY - h * 0.24}
          width={10}
          height={h * 0.22}
          rx={2}
          fill={rejecting ? 'var(--warn)' : 'var(--bg-elev)'}
        />
      </g>

      {/* the pack under inspection */}
      <rect className={s.hair} x={w * 0.2} y={laneY + laneH * 0.2} width={w * 0.1} height={laneH * 0.6} rx={1} />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle">
        {rejecting ? 'ejecting' : 'passing'}
      </text>
    </g>
  )
}
