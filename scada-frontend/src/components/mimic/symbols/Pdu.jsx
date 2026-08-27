import s from './symbols.module.css'

/** Outlets down the strip. Enough to read as a bank, not so many they blur. */
const OUTLETS = 8

/**
 * Pdu — rack power distribution unit: a vertical strip of outlets on the
 * conductor between the UPS above it and the rack below.
 *
 * Drawn schematically, unlike Rack. A PDU's face is a row of identical sockets
 * and tells an operator nothing; what matters is that it is a tap point on the
 * power chain carrying a load. So the outlets are hairlines and the load is the
 * readout.
 */
export default function Pdu({ node, tag }) {
  const { w, h } = node
  const live = tag?.state !== 'stop'
  const amps = tag?.display ?? '––'

  const cx = w / 2
  const stripW = w * 0.46
  const stripX = cx - stripW / 2
  const stripY = h * 0.16
  const stripH = h * 0.62

  return (
    <g className={live ? '' : s.stopped}>
      {/* conductor in from above, out to the rack below */}
      <line className={s.body} x1={cx} y1={0} x2={cx} y2={stripY} />
      <line className={s.body} x1={cx} y1={stripY + stripH} x2={cx} y2={h} />

      <rect className={s.bodyElev} x={stripX} y={stripY} width={stripW} height={stripH} rx={2} />

      {/* the outlet bank */}
      {Array.from({ length: OUTLETS }, (_, i) => stripY + (stripH * (i + 0.5)) / OUTLETS).map((y) => (
        <g key={y}>
          <line className={s.hair} x1={stripX + 3} y1={y} x2={stripX + stripW - 3} y2={y} />
          <circle
            className={live ? s.accentFill : s.hairFill}
            cx={stripX + stripW - 5}
            cy={y}
            r={1.4}
          />
        </g>
      ))}

      <text className={s.readout} x={cx} y={h * 0.94} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {amps} A
      </text>
      <text
        className={s.label}
        x={cx}
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
