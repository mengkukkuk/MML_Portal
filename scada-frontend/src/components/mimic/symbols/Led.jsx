import { stateColor, statusColor } from '../tagStatus'
import s from './symbols.module.css'

/**
 * Led — a panel indicator lamp. Round, because that is what an indicator is on
 * every control panel ever built, and because round is the one shape on this
 * sheet that carries no process meaning and so can be read purely as a light.
 *
 * ## Where the colour comes from
 *
 * In priority order, each falling through to the next when it has nothing to
 * say:
 *   1. `state.map` — a coded column mapped onto named states in the binding
 *      dialog. `0 → green, 1 → amber, 2 → red` is the default, and the named
 *      colours are honoured literally: an admin who wrote the map is telling
 *      the lamp what to be, not asking it to interpret.
 *   2. `state` from threshold mode — run lights, stop does not.
 *   3. the analog limits — a lamp on a plain numeric column still means
 *      something, and warn/crit are already derived for every tag.
 *
 * A name this vocabulary does not know falls to status rather than going dark:
 * an admin's own legend ("PURGE") should still light.
 *
 * ## Blink
 *
 * Only crit blinks. Steady for everything else, including amber — the same rule
 * StackLight follows, and for the same reason: a panel where healthy things
 * blink teaches operators that blinking is background.
 */
export default function Led({ node, tag }) {
  const { w, h } = node

  const status = tag?.status ?? 'stale'
  const stale = !tag || status === 'stale'
  const state = tag?.state ? String(tag.state).toLowerCase() : null

  // Explicitly dark states are the one case where "no colour" is the reading,
  // not a gap to fill — an off lamp is information.
  const dark = state === 'stop' || state === 'off' || state === 'closed' || state === 'idle'
  const color = stateColor(state) ?? statusColor(status)
  const lit = !stale && !dark
  const blink = lit && (status === 'crit' || state === 'red' || state === 'alarm')

  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.36

  return (
    <g>
      {/* Bezel. Always drawn at full weight so an unlit lamp is still visibly a
          lamp — a dark circle alone reads as a hole in the drawing. */}
      <circle className={s.bodyElev} cx={cx} cy={cy} r={r * 1.28} />

      <circle
        className={s.lampFace}
        cx={cx}
        cy={cy}
        r={r}
        fill={lit ? color : 'var(--bg-panel)'}
        stroke={lit ? color : 'var(--fg-dim)'}
        opacity={lit ? 1 : 0.55}
      />
      {blink && <circle className={s.beacon} cx={cx} cy={cy} r={r} fill={color} />}

      {/* The lens highlight — the one thing that makes a filled circle read as
          glass with something behind it rather than as a flat dot. */}
      {lit && (
        <circle className={s.lampGlint} cx={cx - r * 0.32} cy={cy - r * 0.34} r={r * 0.24} />
      )}

      {/* A lamp whose source has gone quiet must not sit there looking green.
          The cross-hatch is the drawing convention for "no signal", and it is
          drawn over the lens so it cannot be mistaken for a lit colour. */}
      {stale && (
        <g className={s.hair}>
          <line x1={cx - r * 0.6} y1={cy - r * 0.6} x2={cx + r * 0.6} y2={cy + r * 0.6} />
          <line x1={cx + r * 0.6} y1={cy - r * 0.6} x2={cx - r * 0.6} y2={cy + r * 0.6} />
        </g>
      )}

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
