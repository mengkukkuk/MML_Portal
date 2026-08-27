import s from './symbols.module.css'

/**
 * NetworkSwitch — the managed switch the control network hangs off. Drawn as
 * a port row, because on a plant network drawing the question is never "is
 * there a switch here" but "how many things does it carry".
 */
export default function NetworkSwitch({ node, tag }) {
  const { w, h } = node
  const up = tag?.state === 'run' || tag?.state === 'closed'
  const ports = 8

  const bodyH = h * 0.62
  const portW = (w * 0.82) / ports

  return (
    <g className={up ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={bodyH} rx={3} />

      {Array.from({ length: ports }, (_, i) => {
        const x = w * 0.09 + i * portW
        return (
          <g key={i}>
            <rect
              className={s.body}
              x={x + 1.5}
              y={bodyH * 0.3}
              width={portW - 3}
              height={bodyH * 0.42}
              rx={1.5}
            />
            {up && i < ports - 2 && (
              <circle className={s.beacon} cx={x + portW / 2} cy={bodyH * 0.17} r={2} fill="var(--ok)" />
            )}
          </g>
        )
      })}

      <text className={s.label} x={w / 2} y={h + 4} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 17} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {up ? 'link up' : 'link down'}
      </text>
    </g>
  )
}
