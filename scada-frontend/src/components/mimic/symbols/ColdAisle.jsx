import s from './symbols.module.css'

/**
 * ColdAisle — a contained aisle: two rows of cabinets facing each other across
 * the cold air, with the containment drawn around them.
 *
 * An *area* symbol rather than a device. The rest of this catalogue draws things
 * that sit on a line and carry something between two ports; this draws a place,
 * and its reading is a property of that place — the aisle temperature, or the ΔT
 * across it. That is why it is wide and low and hollow rather than a block: it is
 * meant to be dropped behind a row of racks, not wired in series with them.
 *
 * The containment is a dashed outline because containment is a boundary, and the
 * standing convention on these sheets is that a dashed line encloses rather than
 * conducts. Nothing marches through it — no product flows along an aisle.
 */
export default function ColdAisle({ node, tag }) {
  const { w, h } = node
  const cabs = 5
  const temp = tag?.display

  const rowH = h * 0.3
  const topY = h * 0.1
  const botY = h - topY - rowH
  const gap = w * 0.03
  const cabW = (w - gap * (cabs + 1)) / cabs

  const cabinets = (y) => Array.from({ length: cabs }, (_, i) => (
    <rect
      key={`${y}-${i}`}
      className={s.body}
      x={gap + i * (cabW + gap)}
      y={y}
      width={cabW}
      height={rowH}
      rx={1}
    />
  ))

  return (
    <g>
      {/* the containment envelope */}
      <rect className={s.aisle} x={0} y={0} width={w} height={h} rx={3} />

      {cabinets(topY)}
      {cabinets(botY)}

      {/* cold air entering the aisle from below — the floor grilles, which is
          what makes this a *cold* aisle rather than an unlabelled pair of rows */}
      {[0.25, 0.5, 0.75].map((t) => (
        <path
          key={t}
          className={s.accentStroke}
          d={`M ${w * t} ${h * 0.62} l -4 6 M ${w * t} ${h * 0.62} l 4 6 M ${w * t} ${h * 0.62} v 10`}
          opacity={0.6}
        />
      ))}

      {temp != null && (
        <text className={s.readout} x={w / 2} y={h * 0.56} textAnchor="middle"
              transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
          {temp}{tag?.unit ? ` ${tag.unit}` : '°'}
        </text>
      )}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  )
}
