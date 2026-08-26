import { stateColor } from '../tagStatus'
import { useConditionMet } from '../conditions'
import s from './symbols.module.css'

const CHAR_W = 0.58
const MAX_LINES = 3

/**
 * Greedy word wrap for the legend. Mono figures make the advance exact enough
 * to pack by character count, and the last line is ellipsised rather than
 * dropped — a legend that silently loses its last word is worse than one that
 * visibly ran out of room.
 */
function wrap(text, chars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const lines = []
  let line = ''
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word
    if (next.length <= chars || !line) { line = next; return }
    lines.push(line)
    line = word
  })
  lines.push(line)
  if (lines.length <= MAX_LINES) return lines
  const kept = lines.slice(0, MAX_LINES)
  kept[MAX_LINES - 1] = `${kept[MAX_LINES - 1].slice(0, Math.max(1, chars - 1))}…`
  return kept
}

/**
 * AlertBadge — an annunciator tile, the alarm window off a control-room panel.
 *
 * Drawn as the real article rather than as a warning triangle, because the real
 * article answers a question a triangle cannot: an annunciator is *always*
 * present, dark and engraved when its condition is clear, so an operator learns
 * where each alarm lives and can see at a distance that it is not in alarm. A
 * badge that only appears when something is wrong teaches nobody the panel, and
 * an empty space cannot be distinguished from a symbol that failed to render.
 *
 * ## The condition
 *
 * By default: whatever already makes a tag warn or crit — the four limits from
 * the binding dialog, or a `state.map` naming an alarm state. Nothing to
 * configure, and the tile and the gauge beside it can never disagree.
 *
 * `options.when` replaces that with a condition the admin wrote — `a > 80`,
 * `a < 2 or a > 90`. It **replaces** rather than adds to it, which is
 * the important decision here. An annunciator answers one question, and a tile
 * lit by either of two rules cannot answer it: an operator looking at a lit tile
 * next to a gauge reading 60 has no way to tell whether the limits fired or the
 * expression did, and no way to know which one to go and fix. One tile, one
 * rule, stated in one place.
 *
 * `options.severity` says whether that condition is a warning or an alarm,
 * because an expression can only report that it is true — it cannot know how
 * much the plant should care.
 *
 * Crit flashes, warn holds steady. There is no acknowledge here — this is a
 * mimic, and the Alarms page owns that action.
 */
export default function AlertBadge({ node, tag }) {
  const { w, h } = node

  const status = tag?.status ?? 'stale'
  const stale = !tag || status === 'stale'
  const named = stateColor(tag?.state)
  // A mapped alarm state lights the tile even on a tag whose limits are unset,
  // which is the whole reason `state.map` exists for coded columns.
  const alarmByState = named === 'var(--crit)'
  const warnByState = named === 'var(--warn)'

  // null when no expression is configured, which is what keeps "no rule" from
  // being read as "rule not met" and silencing the limits below.
  const met = useConditionMet(node.options?.when, tag?.condValue)
  const authored = met !== null

  const crit = !stale && (authored
    ? met && node.options?.severity !== 'warning'
    : status === 'crit' || alarmByState)
  const warn = !stale && !crit && (authored
    ? met && node.options?.severity === 'warning'
    : status === 'warn' || warnByState)
  const lit = crit || warn
  const color = crit ? 'var(--crit)' : 'var(--warn)'

  const inset = Math.min(6, w * 0.04)
  const size = Math.max(9, Math.min(15, h * 0.2))
  const chars = Math.max(6, Math.floor((w - inset * 4) / (size * CHAR_W)))
  const lines = wrap(node.label || tag?.id || 'alarm', chars)
  const top = h / 2 - ((lines.length - 1) * size * 1.25) / 2 + size * 0.34

  return (
    <g>
      {/* Housing, then the window. Two rects because a real tile is a lens set
          into a frame, and the frame is what stays visible when the lens is
          dark. */}
      <rect className={s.bodyElev} x={0} y={0} width={w} height={h} rx={3} />

      <rect
        className={s.tileFace}
        x={inset}
        y={inset}
        width={w - inset * 2}
        height={h - inset * 2}
        rx={2}
        fill={lit ? color : 'var(--bg-app)'}
        stroke={lit ? color : 'var(--fg-dim)'}
        opacity={lit ? 1 : 0.7}
      />
      {crit && (
        <rect
          className={s.beacon}
          x={inset}
          y={inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={2}
          fill={color}
        />
      )}

      {/* The legend is engraved into the lens, so it is one element that changes
          contrast rather than two that swap — the words never move or reflow
          when the tile lights. */}
      {lines.map((line, i) => (
        <text
          key={line + i}
          className={`${s.tileLegend} ${lit ? s.tileLegendLit : ''}`}
          x={w / 2}
          y={top + i * size * 1.25}
          textAnchor="middle"
          style={{ fontSize: `${size}px` }}
        >
          {line}
        </text>
      ))}

      {/* Nothing is reaching this tile, so it cannot claim the condition is
          clear. Hatched rather than dark: a dark tile means "not in alarm". */}
      {stale && (
        <rect
          className={s.tileStale}
          x={inset}
          y={inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={2}
        />
      )}
    </g>
  )
}
