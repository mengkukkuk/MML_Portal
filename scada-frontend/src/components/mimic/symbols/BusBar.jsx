import s from './symbols.module.css'

/**
 * BusBar — the switchboard bus. Drawn as IEC 60617 draws it: one heavy
 * horizontal conductor with stub taps, because on a single-line diagram the
 * bus is the datum everything else hangs off rather than a piece of kit.
 *
 * De-energised is the honest failure state, so an unbound or dead bus loses
 * its accent and reads as a plain bar.
 */
export default function BusBar({ node, tag }) {
  const { w, h } = node
  const live = tag?.state === 'run' || tag?.state === 'closed'
  const y = h * 0.5
  const taps = 5

  return (
    <g className={live ? '' : s.stopped}>
      {/* the conductor itself — heavier than any other stroke on the drawing */}
      <line
        className={live ? s.accentStroke : s.body}
        x1={0}
        y1={y}
        x2={w}
        y2={y}
        strokeWidth={5}
        strokeLinecap="round"
      />

      {/* stub taps: where feeders would land */}
      {Array.from({ length: taps }, (_, i) => {
        const x = ((i + 1) * w) / (taps + 1)
        return (
          <line key={x} className={s.hair} x1={x} y1={y} x2={x} y2={y + h * 0.3} />
        )
      })}

      <text
        className={s.label}
        x={w / 2}
        y={y - 12}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 14} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {live ? 'energised' : 'dead'}
      </text>
    </g>
  )
}
