import s from './symbols.module.css'

/**
 * Ups — uninterruptible supply, drawn as the three paths it can actually take:
 * rectifier → DC link → inverter through the middle, the battery hanging off the
 * DC link, and the static bypass arcing over the top.
 *
 * Which path is live *is* the state, so the drawing highlights one of the three
 * rather than printing a word. Bind this with `state.mode: 'map'` — a coded
 * register (0/1/2) becomes `run` / `battery` / `bypass`.
 *
 * On battery, the battery leg blinks: the supply is working exactly as designed
 * and is also on a clock, which is the one UPS condition an operator must not
 * scroll past. `run` sits steady, because a blinking "mains is fine" trains
 * people to ignore blinking — the same rule StackLight follows.
 */
export default function Ups({ node, tag }) {
  const { w, h } = node
  const state = tag?.state ?? 'run'
  const onBattery = state === 'battery'
  const onBypass = state === 'bypass'
  const onMains = !onBattery && !onBypass

  const midY = h * 0.46
  const triH = h * 0.3
  const triW = w * 0.2
  const leftX = w * 0.14
  const rightX = w * 0.86
  const linkL = leftX + triW
  const linkR = rightX - triW

  return (
    <g>
      <rect className={s.bodyElev} x={0} y={h * 0.12} width={w} height={h * 0.76} rx={3} />

      {/* static bypass, over the top of both conversion stages */}
      <path
        className={onBypass ? s.accentStroke : s.hair}
        d={`M ${leftX} ${midY} V ${h * 0.2} H ${rightX} V ${midY}`}
        fill="none"
      />

      {/* rectifier, then inverter */}
      <path
        className={s.body}
        d={`M ${leftX} ${midY - triH / 2} L ${linkL} ${midY} L ${leftX} ${midY + triH / 2} Z`}
      />
      <path
        className={s.body}
        d={`M ${rightX} ${midY - triH / 2} L ${linkR} ${midY} L ${rightX} ${midY + triH / 2} Z`}
      />
      <line
        className={onMains ? s.accentStroke : s.hair}
        x1={linkL}
        y1={midY}
        x2={linkR}
        y2={midY}
      />

      {/* the battery leg, dropping off the DC link. Long and short bars is the
          IEC cell — a rectangle labelled BATT would be a caption, not a symbol. */}
      <g className={onBattery ? '' : s.stopped}>
        <line
          className={onBattery ? s.accentStroke : s.hair}
          x1={w / 2}
          y1={midY}
          x2={w / 2}
          y2={h * 0.66}
        />
        {onBattery && (
          <line className={s.beacon} x1={w / 2} y1={midY} x2={w / 2} y2={h * 0.66} stroke="var(--warn)" strokeWidth={2.5} />
        )}
        <line className={s.body} x1={w / 2 - 11} y1={h * 0.68} x2={w / 2 + 11} y2={h * 0.68} />
        <line className={s.body} x1={w / 2 - 5} y1={h * 0.73} x2={w / 2 + 5} y2={h * 0.73} />
        <line className={s.body} x1={w / 2 - 11} y1={h * 0.78} x2={w / 2 + 11} y2={h * 0.78} />
      </g>

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle">
        {onBattery ? 'on battery' : onBypass ? 'bypass' : 'on line'}
      </text>
    </g>
  )
}
