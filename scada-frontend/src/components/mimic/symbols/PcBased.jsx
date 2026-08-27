import s from './symbols.module.css'

/**
 * PcBased — the frame-grabber PC that pulls images off one or more cameras
 * and runs the inspection. Drawn like Plc.jsx's rack (a chassis an engineer
 * actually opens), but with camera-link drops along the bottom instead of
 * I/O cards, because what this box terminates is video, not field wiring.
 */
export default function PcBased({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const links = 3

  const bodyH = h * 0.66
  const linkY = bodyH - 10

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={bodyH} rx={3} />

      <circle
        className={running ? s.beacon : ''}
        cx={12}
        cy={12}
        r={3.5}
        fill={running ? 'var(--ok)' : 'var(--fg-dim)'}
      />
      <text className={s.labelDim} x={w - 10} y={16} textAnchor="end">
        PC
      </text>

      {/* vent slits */}
      {[0.32, 0.48, 0.64].map((t) => (
        <line key={t} className={s.hair} x1={w * 0.6} y1={bodyH * t} x2={w * 0.92} y2={bodyH * t} />
      ))}

      {/* camera-link drops */}
      {Array.from({ length: links }, (_, i) => {
        const lw = w * 0.16
        const x = w * 0.14 + i * (lw + w * 0.06)
        return (
          <rect
            key={i}
            className={s.body}
            x={x}
            y={linkY}
            width={lw}
            height={10}
            rx={1.5}
            fill="var(--bg-app)"
          />
        )
      })}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {running ? 'processing' : 'idle'}
      </text>
    </g>
  )
}
