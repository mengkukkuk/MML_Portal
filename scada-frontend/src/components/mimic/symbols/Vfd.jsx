import s from './symbols.module.css'

/**
 * Vfd — variable frequency drive. Drawn as the two conversion stages it
 * actually is: a rectifier triangle feeding a DC link, feeding an inverter
 * triangle. The output frequency is the number that matters on a mimic, so it
 * sits on the DC link between them.
 */
export default function Vfd({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'
  const hz = tag?.display ?? '––'

  const midY = h * 0.46
  const triH = h * 0.36
  const triW = w * 0.24

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={h} rx={3} />

      {/* rectifier: mains in on the left */}
      <path
        className={s.body}
        d={`M ${w * 0.1} ${midY - triH / 2} L ${w * 0.1 + triW} ${midY} L ${w * 0.1} ${midY + triH / 2} Z`}
      />
      {/* inverter: motor out on the right, mirrored */}
      <path
        className={s.body}
        d={`M ${w * 0.9} ${midY - triH / 2} L ${w * 0.9 - triW} ${midY} L ${w * 0.9} ${midY + triH / 2} Z`}
      />

      {/* DC link — the pair of bars is the capacitor */}
      <line
        className={running ? s.accentStroke : s.hair}
        x1={w * 0.1 + triW}
        y1={midY}
        x2={w * 0.9 - triW}
        y2={midY}
      />
      <line className={s.hair} x1={w / 2 - 3} y1={midY - 9} x2={w / 2 - 3} y2={midY + 9} />
      <line className={s.hair} x1={w / 2 + 3} y1={midY - 9} x2={w / 2 + 3} y2={midY + 9} />

      <text className={s.readout} x={w / 2} y={h * 0.86} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {hz} Hz
      </text>
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
    </g>
  )
}
