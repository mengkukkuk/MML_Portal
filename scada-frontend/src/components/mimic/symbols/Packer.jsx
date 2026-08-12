import s from './symbols.module.css'

/**
 * Packer — the packer that collates sticks into a pack. The dot group is
 * 7-6-7: that is the real array inside a twenty-stick hinge-lid pack, and
 * drawing it as a neat grid would make the symbol generic. A line operator
 * recognises the shape instantly.
 */
export default function Packer({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const rows = [7, 6, 7]
  const packX = w * 0.24
  const packY = h * 0.16
  const packW = w * 0.52
  const packH = h * 0.54

  const dotR = Math.min(packW / 18, packH / 10)
  const rowGap = packH / 4

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={h * 0.06} width={w} height={h * 0.84} rx={3} />

      {/* the pack being collated */}
      <rect className={s.body} x={packX} y={packY} width={packW} height={packH} rx={2} />

      {rows.map((count, r) => {
        const y = packY + rowGap * (r + 1)
        const stride = packW / (count + 1)
        return (
          <g key={r}>
            {Array.from({ length: count }, (_, i) => (
              <circle
                key={i}
                className={s.hairFill}
                cx={packX + stride * (i + 1)}
                cy={y}
                r={dotR}
              />
            ))}
          </g>
        )
      })}

      {/* infeed sticks and the discharge pusher */}
      {[0.06, 0.11, 0.16].map((k) => (
        <rect key={k} className={s.hair} x={w * k} y={h * 0.4} width={w * 0.03} height={h * 0.16} rx={1} />
      ))}
      <path
        className={s.accentStroke}
        d={`M ${w * 0.82} ${h * 0.48} L ${w * 0.94} ${h * 0.48}`}
      />
      <path className={s.accentStroke} d={`M ${w * 0.9} ${h * 0.44} L ${w * 0.94} ${h * 0.48} L ${w * 0.9} ${h * 0.52}`} />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle">
        {running ? 'packing' : 'stopped'}
      </text>
    </g>
  )
}
