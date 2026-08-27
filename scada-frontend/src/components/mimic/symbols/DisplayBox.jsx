import { formatValue, isNumeric, stateColor, statusColor } from '../tagStatus'
import useValueTransition from '../useValueTransition'
import s from './symbols.module.css'

const CHAR_W = 0.6

/**
 * Travel in logical units per second, not a loop duration.
 *
 * A duration would make a long legend race and a short one crawl, so the same
 * "slow" would mean two different things on two boxes of the same drawing.
 * Fixing the *speed* instead means the setting reads the way an operator would
 * describe it, and a longer message simply takes longer to go by.
 */
export const MARQUEE_SPEEDS = { slow: 16, medium: 38, fast: 76 }

/**
 * DisplayBox — a bound column, printed. The plain-text counterpart to the
 * dials: no scale, no needle, no implied range, just what the column says.
 *
 * ## Where the word comes from
 *
 * Two ways, and this symbol cannot tell them apart on purpose. Bind it to a
 * **text** column and the stored word is printed as written. Bind it to a
 * numeric one and `state.map` names the codes — 0 → IDLE, 1 → RUN, 2 → FAULT.
 * Both arrive here as `tag.state`, so the box has one text path however the
 * plant chose to store its status; with neither, it prints the formatted number
 * and its unit. One symbol covers all three because to an operator they are the
 * same question: what does this column currently say.
 *
 * ## The notifier
 *
 * A pip in the top-right corner, and nothing else. It is the add-on, so it stays
 * an add-on: the box does not flash, resize or change its lettering when a
 * reading goes off normal, because the text is what people came to read. A
 * stale box gets a hollow pip rather than a coloured one — "we have not heard
 * from this" is not a plant condition and must not be drawn as one.
 *
 * ## Moving text
 *
 * `options.marquee` (off by default) runs the legend as a ticker at one of three
 * speeds. It exists because the still box solves overflow by *shrinking* the
 * text, and past a certain length that trades unreadable-because-clipped for
 * unreadable-because-tiny. A marquee box keeps full-size lettering and spends
 * time instead of space.
 *
 * It is opt-in per symbol rather than automatic-on-overflow, because motion on
 * a mimic is a signal: a board where boxes start and stop scrolling as their
 * text changes length has movement that means nothing, and that is exactly what
 * teaches operators to stop looking at movement that does.
 */
export default function DisplayBox({ node, tag }) {
  const { w, h } = node
  const { pulse } = useValueTransition(tag)

  const status = tag?.status ?? 'stale'
  const stale = !tag || status === 'stale'
  // A state — read from a text column or mapped from a code — is the whole point
  // of the symbol, so it wins over any number beside it: printing both would be
  // the same fact twice.
  const mapped = tag?.state ? String(tag.state).toUpperCase() : null
  const text = mapped ?? (isNumeric(tag?.value) ? formatValue(tag) : '––')
  const unit = mapped ? '' : (tag?.unit ?? '')

  const pad = Math.min(9, w * 0.06)
  const capY = h * 0.3
  const bodyH = h - capY

  const speed = MARQUEE_SPEEDS[node.options?.marquee]
  const chars = text.length + unit.length * 0.8
  // A scrolling box is never shrunk to fit: fitting is the job it was turned on
  // to stop doing.
  const size = speed ? bodyH * 0.54 : Math.min(bodyH * 0.54, (w - pad * 2) / (chars * CHAR_W))
  const baseline = capY + bodyH / 2 + size * 0.35

  // One full cycle is the legend plus a gap wide enough that its tail has
  // cleared the box before its head returns — otherwise the message appears to
  // wrap onto itself and there is no visible "start" to read from.
  const period = chars * size * CHAR_W + Math.max(w * 0.6, size * 3)

  const pipR = Math.min(5, h * 0.09)
  const pipColor = stateColor(tag?.state) ?? statusColor(status)

  const statusClass = status === 'crit' ? s.statusCrit : status === 'warn' ? s.statusWarn : ''

  return (
    <g className={statusClass}>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={3} />
      <line className={s.hair} x1={0} y1={capY} x2={w} y2={capY} />

      <text className={s.labelDim} x={pad} y={capY - 7}>
        {tag?.id ?? node.tagId ?? node.label}
      </text>

      {/* The notifier. Hollow while stale, so a silent source never reads as a
          healthy green one. */}
      <circle
        className={s.pip}
        cx={w - pad - pipR}
        cy={capY / 2 - 1}
        r={pipR}
        fill={stale ? 'none' : pipColor}
        stroke={stale ? 'var(--fg-dim)' : pipColor}
      />

      {speed ? (
        <>
          {/* The clip is what makes this a window rather than text that runs
              across the neighbouring symbols. Keyed by node id, since two boxes
              on one sheet would otherwise share a clip path. */}
          <clipPath id={`mq-${node.id}`}>
            <rect x={pad} y={capY} width={w - pad * 2} height={bodyH} />
          </clipPath>
          {/* No key={pulse} and no .roll here, unlike the still box below: a
              re-mount on every poll would restart the scroll from zero, and at a
              1s cadence the message would never get past its first word. */}
          <g clipPath={`url(#mq-${node.id})`}>
            <g
              className={s.marquee}
              style={{
                '--mimic-marquee-period': period,
                animationDuration: `${period / speed}s`,
              }}
            >
              {/* Two copies, one period apart: the second is already entering as
                  the first leaves, so the loop has no blank pass. */}
              {[0, period].map((offset) => (
                <text
                  key={offset}
                  className={s.boxValue}
                  x={pad + offset}
                  y={baseline}
                  textAnchor="start"
                  style={{ fontSize: `${size}px`, fill: mapped ? pipColor : undefined }}
                  aria-hidden={offset ? 'true' : undefined}
                >
                  {text}
                  {unit && <tspan className={s.counterUnit} dx={size * 0.24}>{unit}</tspan>}
                </text>
              ))}
            </g>
          </g>
        </>
      ) : (
        <text
          key={pulse}
          className={`${s.boxValue} ${s.roll}`}
          x={w / 2}
          y={baseline}
          textAnchor="middle"
          style={{ fontSize: `${size}px`, fill: mapped ? pipColor : undefined }}
        >
          {text}
          {unit && <tspan className={s.counterUnit} dx={size * 0.24}>{unit}</tspan>}
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
