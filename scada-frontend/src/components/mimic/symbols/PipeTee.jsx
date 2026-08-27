import s from './symbols.module.css'

/**
 * PipeTee — steam header junction. The only untagged symbol in the set: a
 * tee carries no measurement, and drawing a bubble on it would imply one.
 * It exists so branch topology reads correctly.
 */
export default function PipeTee({ node }) {
  const { w, h } = node
  const cx = w / 2
  const cy = h / 2

  return (
    <g>
      <path
        className={s.body}
        d={`M 0 ${cy - h * 0.16} H ${cx - w * 0.16} V ${h} H ${cx + w * 0.16} V ${cy - h * 0.16} H ${w} V ${cy + h * 0.16} H 0 Z`}
        fill="var(--bg-elev)"
      />
      <circle className={s.hairFill} cx={cx} cy={cy} r={3} />
      <text
        className={s.labelDim}
        x={cx}
        y={-8}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
    </g>
  )
}
