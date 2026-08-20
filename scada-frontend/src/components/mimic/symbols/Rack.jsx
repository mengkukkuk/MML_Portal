import s from './symbols.module.css'

/** Rack units drawn across the face. 42U at full height would be hairline mush. */
const U_RULES = 14

/**
 * Rack — a server cabinet, drawn as a **front elevation** rather than a
 * schematic block.
 *
 * The one deliberate departure from the IEC/ISA language the rest of this
 * catalogue speaks. Every other symbol here is a diagram of a function, because
 * that is how an engineer reads a pipe or a breaker. A rack is the opposite: it
 * is the one piece of equipment recognised by its face, and every real DCIM tool
 * draws it that way. A schematic rectangle labelled "rack" would carry strictly
 * less information than its own picture.
 *
 * The fill is the load — climbing the face from the bottom, against U rules, so
 * "how full is this cabinet" is answered by the geometry rather than by reading a
 * number off it. Tank's `.liquid` transition does the tweening, so a new reading
 * rises to its level instead of jumping.
 */
export default function Rack({ node, tag }) {
  const { w, h, id } = node
  const clipId = `mimic-clip-${id}`

  const range = tag?.range ?? [0, 100]
  const span = range[1] - range[0] || 1
  const pct = tag?.value == null ? 0 : Math.min(1, Math.max(0, (tag.value - range[0]) / span))

  // The cabinet face, inset from the frame — the posts are part of what makes
  // this read as a rack rather than as a filled box.
  const postW = Math.max(4, w * 0.08)
  const faceX = postW
  const faceW = w - postW * 2
  const faceY = h * 0.06
  const faceH = h * 0.88
  const fillH = faceH * pct

  return (
    <g>
      <clipPath id={clipId}>
        <rect x={faceX} y={faceY} width={faceW} height={faceH} />
      </clipPath>

      {/* cabinet outline and the two mounting posts */}
      <rect className={s.bodyElev} x={0} y={0} width={w} height={h} rx={2} />
      <rect className={s.body} x={faceX} y={faceY} width={faceW} height={faceH} />

      <g clipPath={`url(#${clipId})`}>
        <rect
          className={s.liquid}
          x={faceX}
          y={faceY + faceH - fillH}
          width={faceW}
          height={fillH}
        />
        <line
          className={s.liquidLine}
          x1={faceX}
          y1={faceY + faceH - fillH}
          x2={faceX + faceW}
          y2={faceY + faceH - fillH}
        />
      </g>

      {/* U rules. Drawn over the fill so the level is read *against* the rack's
          own scale — a bar with no graduations tells you a proportion but not
          how much equipment that is. */}
      {Array.from({ length: U_RULES - 1 }, (_, i) => faceY + (faceH * (i + 1)) / U_RULES).map((y) => (
        <line key={y} className={s.hair} x1={faceX} y1={y} x2={faceX + faceW} y2={y} />
      ))}

      {/* perforated top panel — where the air actually leaves */}
      {[0.3, 0.5, 0.7].map((t) => (
        <line key={t} className={s.hair} x1={w * t} y1={2} x2={w * t} y2={faceY - 1} />
      ))}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
