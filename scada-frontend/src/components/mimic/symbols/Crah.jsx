import s from './symbols.module.css'

/**
 * Crah — computer-room air handler: return air in on one side, a chilled-water
 * coil, a fan, and supply air out the other.
 *
 * Drawn left-to-right rather than top-to-bottom, because this sits on the cooling
 * loop rather than the power chain, and a sheet reads much better when the two
 * chains run at right angles to each other.
 *
 * The fan spins while the unit is running and pauses in place when it stops. The
 * coil is a serpentine because that is what a coil is — a box with "COIL" in it
 * would be a label pretending to be a symbol.
 */
export default function Crah({ node, tag }) {
  const { w, h } = node
  const running = tag?.state !== 'stop'
  const temp = tag?.display

  const boxY = h * 0.1
  const boxH = h * 0.7
  const coilX = w * 0.2
  const coilW = w * 0.26
  const fanCx = w * 0.68
  const fanCy = boxY + boxH / 2
  const fanR = Math.min(w * 0.13, boxH * 0.32)

  // Serpentine across the coil face — four passes, which is enough to read as
  // tube-and-fin without turning into a hatch pattern at small sizes.
  const passes = 4
  const coilPath = Array.from({ length: passes }, (_, i) => {
    const x = coilX + (coilW * i) / (passes - 1)
    const down = i % 2 === 0
    return `${i === 0 ? 'M' : 'L'} ${x} ${down ? boxY + boxH * 0.2 : boxY + boxH * 0.8}`
      + ` L ${x} ${down ? boxY + boxH * 0.8 : boxY + boxH * 0.2}`
  }).join(' ')

  return (
    <g className={running ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={boxY} width={w} height={boxH} rx={3} />

      {/* return air in, supply air out — the arrows are the airflow direction,
          which is the one thing a CRAH's orientation on a sheet has to say */}
      <path className={s.hair} d={`M 2 ${boxY + boxH * 0.5} l 10 -4 v 8 z`} fill="var(--fg-dim)" />
      <path
        className={s.hair}
        d={`M ${w - 2} ${boxY + boxH * 0.5} l -10 -4 v 8 z`}
        fill="var(--fg-dim)"
      />

      <path className={s.hair} d={coilPath} fill="none" />

      {/* the fan */}
      <circle className={s.body} cx={fanCx} cy={fanCy} r={fanR} />
      <g className={s.spin}>
        <circle cx={fanCx} cy={fanCy} r={fanR} fill="none" stroke="none" />
        {[0, 120, 240].map((a) => (
          <path
            key={a}
            className={s.accentStroke}
            d={`M ${fanCx} ${fanCy} L ${fanCx + fanR * 0.72 * Math.cos((a * Math.PI) / 180)} ${fanCy + fanR * 0.72 * Math.sin((a * Math.PI) / 180)}`}
          />
        ))}
      </g>

      {temp != null && (
        <text className={s.readout} x={w * 0.1} y={boxY + boxH + 14} textAnchor="start">
          {temp}°
        </text>
      )}
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
    </g>
  )
}
