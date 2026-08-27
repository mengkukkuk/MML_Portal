import s from './symbols.module.css'

/**
 * UvReactor — UV disinfection chamber. The lamp glow pulses (`.beam`) only
 * while the lamps are struck: a UV reactor passing water with dark lamps is
 * an untreated stream, and that is precisely the condition the mimic must not
 * let pass for a working one.
 */
export default function UvReactor({ node, tag }) {
  const { w, h } = node
  const on = tag?.state === 'run'

  const cy = h * 0.5
  const chamberH = h * 0.56
  const lamps = 3

  return (
    <g className={on ? '' : s.stopped}>
      {/* flow-through chamber */}
      <rect
        className={s.body}
        x={w * 0.08}
        y={cy - chamberH / 2}
        width={w * 0.84}
        height={chamberH}
        rx={chamberH / 2}
      />

      {/* inlet / outlet stubs */}
      <line className={s.body} x1={0} y1={cy} x2={w * 0.08} y2={cy} />
      <line className={s.body} x1={w * 0.92} y1={cy} x2={w} y2={cy} />

      {/* the glow, sized to the chamber so it reads as the water being lit */}
      {on && (
        <rect
          className={s.beam}
          x={w * 0.1}
          y={cy - chamberH / 2 + 2}
          width={w * 0.8}
          height={chamberH - 4}
          rx={(chamberH - 4) / 2}
          fill="var(--accent)"
        />
      )}

      {/* quartz sleeves with lamps inside */}
      {Array.from({ length: lamps }, (_, i) => {
        const y = cy - chamberH * 0.28 + (i * chamberH * 0.56) / (lamps - 1)
        return (
          <line
            key={i}
            className={on ? s.accentStroke : s.hair}
            x1={w * 0.16}
            y1={y}
            x2={w * 0.84}
            y2={y}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        )
      })}

      <text
        className={s.label}
        x={w / 2}
        y={h + 14}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 27} textAnchor="middle" transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {on ? 'lamps on' : 'lamps off'}
      </text>
    </g>
  )
}
