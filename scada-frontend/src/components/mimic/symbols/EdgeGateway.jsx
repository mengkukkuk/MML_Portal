import s from './symbols.module.css'

/**
 * EdgeGateway — the box that carries plant data off the control network. The
 * uplink arcs are drawn radiating upward and *away* from the process, which
 * is the honest picture: data leaves here, control does not come back in.
 */
export default function EdgeGateway({ node, tag }) {
  const { w, h } = node
  const connected = tag?.state === 'run' || tag?.state === 'closed'

  const bodyY = h * 0.42
  const bodyH = h * 0.38
  const cx = w / 2
  const arcCy = bodyY - 4

  return (
    <g className={connected ? '' : s.stopped}>
      {/* uplink — three widening arcs, the drawing convention for a radio or
          WAN link rather than a wired drop */}
      {[0.16, 0.26, 0.36].map((k, i) => (
        <path
          key={k}
          className={connected ? s.accentStroke : s.hair}
          d={`M ${cx - w * k} ${arcCy - w * k * 0.55} A ${w * k} ${w * k} 0 0 1 ${cx + w * k} ${arcCy - w * k * 0.55}`}
          fill="none"
          strokeWidth={1.5}
          opacity={connected ? 1 - i * 0.22 : 0.5}
        />
      ))}

      <rect className={s.bodyElev} x={w * 0.16} y={bodyY} width={w * 0.68} height={bodyH} rx={3} />
      <circle
        className={connected ? s.beacon : ''}
        cx={w * 0.24}
        cy={bodyY + 10}
        r={3.5}
        fill={connected ? 'var(--ok)' : 'var(--fg-dim)'}
      />
      <text className={s.labelDim} x={cx} y={bodyY + bodyH - 9} textAnchor="middle">
        GW
      </text>

      <text className={s.label} x={cx} y={h + 12} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={cx} y={h + 25} textAnchor="middle">
        {connected ? 'publishing' : 'offline'}
      </text>
    </g>
  )
}
