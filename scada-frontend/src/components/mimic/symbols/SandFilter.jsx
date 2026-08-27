import s from './symbols.module.css'

/**
 * SandFilter — pressure sand filter. Four ports rather than two, because a
 * filter that can only be drawn in service is a filter you cannot commission:
 * backwash and drain are half of how the vessel is actually operated.
 *
 * Differential pressure across the bed is the reading that says when to
 * backwash, so that is what the symbol carries.
 */
export default function SandFilter({ node, tag }) {
  const { w, h } = node
  const inService = tag?.state !== 'stop' && tag?.state !== 'closed'

  const domeR = w * 0.5
  const shellTop = domeR * 0.55
  const shellBot = h - domeR * 0.55
  const bedTop = shellTop + (shellBot - shellTop) * 0.34

  return (
    <g className={inService ? '' : s.stopped}>
      {/* dished-end pressure vessel */}
      <path
        className={s.body}
        d={`M 0 ${shellTop}
            A ${domeR} ${domeR * 0.55} 0 0 1 ${w} ${shellTop}
            L ${w} ${shellBot}
            A ${domeR} ${domeR * 0.55} 0 0 1 0 ${shellBot}
            Z`}
      />

      {/* graded media: sand over gravel support */}
      <rect
        className={s.liquid}
        x={1}
        y={bedTop}
        width={w - 2}
        height={(shellBot - bedTop) * 0.62}
      />
      {Array.from({ length: 5 }, (_, i) => (
        <line
          key={i}
          className={s.hair}
          x1={2}
          y1={bedTop + 8 + i * ((shellBot - bedTop) * 0.62 - 10) / 4}
          x2={w - 2}
          y2={bedTop + 8 + i * ((shellBot - bedTop) * 0.62 - 10) / 4}
        />
      ))}

      {/* underdrain */}
      <line
        className={s.hair}
        x1={w * 0.12}
        y1={bedTop + (shellBot - bedTop) * 0.62}
        x2={w * 0.88}
        y2={bedTop + (shellBot - bedTop) * 0.62}
      />

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
        {inService ? 'in service' : 'backwash'}
      </text>
    </g>
  )
}
