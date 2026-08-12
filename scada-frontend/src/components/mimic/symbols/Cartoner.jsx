import s from './symbols.module.css'

/**
 * Cartoner — collates ten packs into an outer. Ten ticks, not a generic box:
 * the count is the machine's whole job, and a reader who knows the line can
 * tell at a glance whether they are looking at a cartoner or a case packer.
 */
export default function Cartoner({ node, tag }) {
  const { w, h } = node
  const running = tag?.state === 'run'

  const outerX = w * 0.28
  const outerY = h * 0.2
  const outerW = w * 0.46
  const outerH = h * 0.46

  const packs = 10
  const perRow = 5
  const cellW = outerW / perRow
  const cellH = outerH / 2

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={h * 0.08} width={w} height={h * 0.8} rx={3} />

      {/* the outer being filled */}
      <rect className={s.body} x={outerX} y={outerY} width={outerW} height={outerH} rx={2} />
      {Array.from({ length: packs }, (_, i) => {
        const col = i % perRow
        const row = Math.floor(i / perRow)
        return (
          <rect
            key={i}
            className={s.hair}
            x={outerX + col * cellW + cellW * 0.16}
            y={outerY + row * cellH + cellH * 0.16}
            width={cellW * 0.68}
            height={cellH * 0.68}
            rx={1}
          />
        )
      })}

      {/* infeed lane and discharge */}
      {[0.06, 0.13, 0.2].map((k) => (
        <rect key={k} className={s.hair} x={w * k} y={h * 0.38} width={w * 0.045} height={h * 0.12} rx={1} />
      ))}
      <path
        className={s.accentStroke}
        d={`M ${w * 0.78} ${h * 0.44} L ${w * 0.94} ${h * 0.44} M ${w * 0.9} ${h * 0.4} L ${w * 0.94} ${h * 0.44} L ${w * 0.9} ${h * 0.48}`}
      />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
