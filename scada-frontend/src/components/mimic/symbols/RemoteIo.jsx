import s from './symbols.module.css'

/**
 * RemoteIo — a remote I/O drop out in the field. Slimmer than the PLC rack and
 * with no CPU module, because that difference is exactly what distinguishes
 * the two on a drawing: this one has no logic of its own, it only carries
 * channels back to a controller.
 */
export default function RemoteIo({ node, tag }) {
  const { w, h } = node
  const online = tag?.state === 'run' || tag?.state === 'closed'
  const channels = 8

  const bodyH = h * 0.66

  return (
    <g className={online ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={bodyH} rx={3} />

      {/* network status */}
      <circle
        className={online ? s.beacon : ''}
        cx={12}
        cy={12}
        r={4}
        fill={online ? 'var(--ok)' : 'var(--fg-dim)'}
      />

      {/* channel terminals along the bottom edge — the field wiring lands here */}
      {Array.from({ length: channels }, (_, i) => {
        const x = w * 0.1 + (i * w * 0.8) / (channels - 1)
        return (
          <g key={i}>
            <line className={s.hair} x1={x} y1={bodyH * 0.52} x2={x} y2={bodyH - 6} />
            <circle className={s.hairFill} cx={x} cy={bodyH - 4} r={2} />
          </g>
        )
      })}

      <text className={s.labelDim} x={w / 2} y={bodyH * 0.36} textAnchor="middle">
        I/O
      </text>
      <text className={s.label} x={w / 2} y={h + 6} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 19} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {online ? 'online' : 'no comms'}
      </text>
    </g>
  )
}
