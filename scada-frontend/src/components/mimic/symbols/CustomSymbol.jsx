import useAssetUrl from '../useAssetUrl'
import { isFlowing } from '../tagStatus'
import { knownDynamics } from './dynamics'
import s from './symbols.module.css'

/** Below this a gauge bar is a sliver rather than a legible instrument. */
const BAR_MIN = 12
const GAP_MIN = 6

/**
 * CustomSymbol — renders an admin-authored symbol: an uploaded picture, plus the
 * dynamics that make it move.
 *
 * Layer order is the whole design, and it is not arbitrary:
 *
 *   <g>                      'signal' dynamics — blink, show/hide
 *     <g class=stopped?>     the freeze group
 *       <g>                  'motion' dynamics — spin, stroke, turn
 *         <image>            the picture ('asset' dynamics choose which)
 *       <gauge>               'overlay' dynamic — fill by value, beside the picture
 *
 * The freeze group is why signal and motion are separate. `.stopped` pauses every
 * steady-state animation *beneath* it (symbols.module.css), which is what makes a
 * stopped pump's impeller halt where it was rather than snap to zero. But a
 * stopped machine in alarm still has to blink, so blink has to sit above that
 * group — not below it. Getting this backwards would silence exactly the symbol
 * an operator most needs to notice.
 *
 * Everything else here follows from reusing that CSS: pause-on-stop, resume from
 * position, and prefers-reduced-motion all come from the same classes the 44
 * hand-drawn symbols wear, so an authored symbol behaves like a native one
 * without re-implementing any of it.
 */
export default function CustomSymbol({ node, def, tag }) {
  const dynamics = knownDynamics(def?.dynamics)

  // An 'asset' dynamic (swap) picks a picture per state; otherwise the symbol's
  // own. `?? def.asset_id` covers a state with no image mapped to it — a symbol
  // that vanished on an unmapped state would read as equipment that is gone.
  const swapped = dynamics
    .filter((e) => e.def.role === 'asset')
    .map((e) => e.def.pick(e.dyn, tag))
    .find((id) => id != null)

  // `previewUrl` is the authoring dialog drawing a file that has not been
  // uploaded yet. It exists so the preview goes through this component rather
  // than a lookalike — a preview built from different code is a preview of
  // something else. Nothing on a saved drawing ever sets it.
  const fetched = useAssetUrl(def?.previewUrl ? null : swapped ?? def?.asset_id ?? null)
  const url = def?.previewUrl ?? fetched

  const { w, h } = node
  // Reuses the same question the pipes ask, so an *unbound* authored symbol
  // animates rather than sitting frozen: on a drawing still being commissioned,
  // stillness would read as a fault that isn't there.
  const stopped = !isFlowing(tag)

  const frameTone = tag?.status === 'crit' ? s.customFrameCrit
    : tag?.status === 'warn' ? s.customFrameWarn
      : tag?.status === 'stale' ? s.customFrameStale : ''

  const layers = (role) => dynamics
    .filter((e) => e.def.role === role)
    .map((e) => ({ key: e.dyn.kind, ...e.def.layer(e.dyn, tag) }))
    .filter((l) => l.className || l.style)

  /**
   * A `fill` dynamic reads as a gauge bar beside the picture, never as a wash
   * drawn over it — a photographic upload with a translucent rect across part
   * of it reads as a rendering glitch, not as "60% full". So the bar's own
   * space is reserved out of the symbol's box and the picture is drawn smaller
   * to make room, rather than the bar being layered on top.
   *
   * The reservation is keyed on whether the dynamic is *configured*, not on
   * whether a live value currently resolves — an unbound symbol still shows an
   * empty gauge track (level 0) rather than the picture jumping to full size
   * the moment a tag stops reporting, and back the moment it resumes.
   */
  const fillEntry = dynamics.find((e) => e.def.role === 'overlay')
  const vertical = !fillEntry || fillEntry.dyn.direction !== 'horizontal'
  const level = fillEntry ? (fillEntry.def.level(fillEntry.dyn, tag) ?? 0) : null

  const barW = Math.max(BAR_MIN, w * 0.16)
  const gapX = Math.max(GAP_MIN, w * 0.05)
  const barH = Math.max(BAR_MIN, h * 0.16)
  const gapY = Math.max(GAP_MIN, h * 0.05)

  const pictureW = fillEntry && vertical ? Math.max(1, w - barW - gapX) : w
  const pictureH = fillEntry && !vertical ? Math.max(1, h - barH - gapY) : h

  // Wrap `inner` in one <g> per layer, outermost first. Each dynamic gets its own
  // element rather than a merged class list because two of them can want the same
  // property — a symbol that both turns by value and strokes while running needs
  // two transforms, and one element can only carry one.
  const nest = (list, inner) => list.reduceRight(
    (acc, l) => <g key={l.key} className={l.className} style={l.style}>{acc}</g>,
    inner,
  )

  const picture = url && (
    // An <image> with no href draws nothing, so the "no image" text below is
    // what stands in while the bytes are in flight or if they never arrive.
    <image
      href={url}
      x={0}
      y={0}
      width={pictureW}
      height={pictureH}
      // The authored size is a suggestion; the drawing's size wins. Letting it
      // letterbox keeps a rack from being stretched into a cabinet, and keeps
      // proportions correct when the gauge has shrunk the space it draws into.
      preserveAspectRatio="xMidYMid meet"
    />
  )

  // Rect edges set directly, the same way Tank.jsx's own `.liquid` works — no
  // clipPath needed here since the bar is a plain rectangle, and setting the
  // fill rect's own y/height is what the CSS transition on those properties
  // (symbols.module.css) actually animates. A clipPath approach would leave
  // the rect itself at full size and tween an invisible clip instead, which is
  // not what `.levelFill`'s `transition: y, height` is written against.
  const gauge = fillEntry && (vertical ? (
    <g className={s.levelBar}>
      <rect className={s.levelTrack} x={pictureW + gapX} y={0} width={barW} height={h} rx={2} />
      <rect
        className={s.levelFill}
        x={pictureW + gapX}
        y={h * (1 - level)}
        width={barW}
        height={h * level}
      />
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          className={s.levelTick}
          x1={pictureW + gapX}
          y1={h * (1 - t)}
          x2={pictureW + gapX + barW}
          y2={h * (1 - t)}
        />
      ))}
    </g>
  ) : (
    <g className={s.levelBar}>
      <rect className={s.levelTrack} x={0} y={pictureH + gapY} width={w} height={barH} rx={2} />
      <rect
        className={s.levelFill}
        x={0}
        y={pictureH + gapY}
        width={w * level}
        height={barH}
      />
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          className={s.levelTick}
          x1={w * t}
          y1={pictureH + gapY}
          x2={w * t}
          y2={pictureH + gapY + barH}
        />
      ))}
    </g>
  ))

  return nest(layers('signal'), (
    <g className={stopped ? s.stopped : undefined}>
      {nest(layers('motion'), picture)}
      {gauge}

      {/* The hairline box, around the picture *and* its gauge — together they
          read as one instrument. An authored symbol is a photograph of
          equipment rather than a drawn schematic, so it gets a frame to sit in
          — that is what keeps it from floating loose among the IEC symbols
          around it. It is also the only part of the symbol that can carry
          status, because an <image> is opaque to CSS and will not take
          var(--warn) the way a drawn body does. That makes this rect the
          status signal, not decoration. */}
      <rect
        className={`${s.customFrame} ${frameTone}`}
        x={0}
        y={0}
        width={w}
        height={h}
        rx={2}
      />

      {/* No picture: either the library entry is still in flight — the common
          case, on every page load — or this node points at one that was deleted.
          Both read the same from here, and both are better served by an honest
          empty frame than by the alarming placeholder an unknown *type* gets.
          Centred on the picture's own area, not the whole box, so it does not
          drift into the gauge when one is present. */}
      {!url && (
        <text className={s.labelDim} x={pictureW / 2} y={pictureH / 2 + 4} textAnchor="middle"
              transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
          no image
        </text>
      )}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {node.label}
      </text>
    </g>
  ))
}
