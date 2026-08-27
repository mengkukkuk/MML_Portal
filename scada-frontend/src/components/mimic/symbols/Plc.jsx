import s from './symbols.module.css'

/**
 * Plc — the controller rack. Drawn as the physical thing an engineer opens the
 * panel and looks at: a backplane with a CPU on the left and I/O cards beside
 * it, and a RUN beacon that is the first thing anyone checks.
 *
 * A PLC in STOP is not "off" — it is powered and not solving logic, which is a
 * far worse condition on a running plant. So a stopped rack keeps its stroke
 * and only loses the beacon.
 */
export default function Plc({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const cards = 5

  const rackY = h * 0.12
  const rackH = h * 0.62

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={rackY + rackH + h * 0.1} rx={3} />

      {/* CPU module */}
      <rect
        className={s.body}
        x={w * 0.05}
        y={rackY}
        width={w * 0.18}
        height={rackH}
        rx={2}
      />
      <circle
        className={running ? s.beacon : ''}
        cx={w * 0.14}
        cy={rackY + 12}
        r={4}
        fill={running ? 'var(--ok)' : 'var(--fg-dim)'}
      />
      <text className={s.labelDim} x={w * 0.14} y={rackY + rackH - 6} textAnchor="middle">
        CPU
      </text>

      {/* I/O cards */}
      {Array.from({ length: cards }, (_, i) => {
        const cw = w * 0.12
        const x = w * 0.27 + i * (cw + w * 0.025)
        return (
          <g key={i}>
            <rect className={s.body} x={x} y={rackY} width={cw} height={rackH} rx={2} />
            {[0, 1, 2, 3].map((k) => (
              <line
                key={k}
                className={s.hair}
                x1={x + 3}
                y1={rackY + 10 + k * 9}
                x2={x + cw - 3}
                y2={rackY + 10 + k * 9}
              />
            ))}
          </g>
        )
      })}

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
        {running ? 'run' : 'stop'}
      </text>
    </g>
  )
}
