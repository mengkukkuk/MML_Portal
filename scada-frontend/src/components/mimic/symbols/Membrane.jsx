import s from './symbols.module.css'

/**
 * Membrane — RO / UF membrane module. Three ports, not two: feed in, permeate
 * out, concentrate to reject. A membrane drawn with a single outlet would
 * hide the reject stream, which is where most of a plant's water goes.
 *
 * The two outlets leave at different heights so the drawing itself says which
 * is the product and which is the waste.
 */
export default function Membrane({ node, tag }) {
  const { w, h } = node
  const running = tag?.state !== 'stop'

  const vesselY = h * 0.2
  const vesselH = h * 0.5
  const cy = vesselY + vesselH / 2

  return (
    <g className={running ? '' : s.stopped}>
      {/* pressure vessel */}
      <rect
        className={s.body}
        x={w * 0.1}
        y={vesselY}
        width={w * 0.8}
        height={vesselH}
        rx={vesselH / 2}
      />

      {/* spiral-wound element: the diagonal hatching is the wrap */}
      {Array.from({ length: 7 }, (_, i) => {
        const x = w * 0.16 + (i * w * 0.68) / 6
        return (
          <line
            key={i}
            className={s.hair}
            x1={x}
            y1={vesselY + 4}
            x2={x + w * 0.06}
            y2={vesselY + vesselH - 4}
          />
        )
      })}

      {/* permeate tube down the axis — the product path */}
      <line
        className={s.accentStroke}
        x1={w * 0.12}
        y1={cy}
        x2={w * 0.88}
        y2={cy}
        strokeWidth={1.5}
        strokeDasharray="5 4"
      />

      <text className={s.labelDim} x={w * 0.5} y={vesselY - 6} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        RO
      </text>
      <text className={s.label} x={w / 2} y={h + 4} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
