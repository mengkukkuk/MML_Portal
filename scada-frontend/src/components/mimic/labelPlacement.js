/**
 * Where a symbol's title (node.label) sits relative to its box.
 *
 * Every symbol used to print its title at a fixed `y = h + 18`, which is right
 * at the default size and only there: hand-tuning that constant for one size
 * (say `h - 83` to lift it over an 82-high counter) drops it into the middle
 * of the face the moment the box is resized. The position is instead derived
 * from the box edge the admin chose, so it holds at any size and any rotation.
 */

export const LABEL_PLACES = [
  { id: 'below', label: 'Below' },
  { id: 'above', label: 'Above' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'hidden', label: 'Hidden' },
]

const PLACE_IDS = new Set(LABEL_PLACES.map((p) => p.id))
const DEFAULT_SIZE = 12
// Clear air between the box edge and the nearest edge of the text.
const GAP = 9

/** The stored placement, falling back to the historical "below". */
export function labelPlace(options) {
  const p = options?.labelPlace
  return PLACE_IDS.has(p) ? p : 'below'
}

/**
 * Text attributes for the title of a `w × h` node rotated by `rot` degrees.
 *
 * The title is counter-rotated about the box centre so it always reads
 * upright; the returned x/y are in that upright frame. The edges are those of
 * the rotated box's bounding box, so "below" means below what the operator
 * sees, not below the unrotated drawing.
 *
 * @returns {null | { x: number, y: number, textAnchor: string, transform?: string, style: object }}
 *   null when the title is hidden.
 */
export function labelProps(node) {
  const place = labelPlace(node.options)
  if (place === 'hidden') return null

  const { w, h } = node
  const rot = node.rot || 0
  const size = node.options?.labelSize ?? DEFAULT_SIZE
  const cx = w / 2
  const cy = h / 2

  const rad = (rot * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const halfW = (w * cos + h * sin) / 2
  const halfH = (w * sin + h * cos) / 2

  // Baseline offsets for uppercase display text: cap height is ~0.72em, so a
  // baseline at +0.36em centres it vertically on a line.
  let x = cx
  let y
  let textAnchor = 'middle'
  if (place === 'above') {
    y = cy - halfH - GAP
  } else if (place === 'left') {
    x = cx - halfW - GAP
    y = cy + size * 0.36
    textAnchor = 'end'
  } else if (place === 'right') {
    x = cx + halfW + GAP
    y = cy + size * 0.36
    textAnchor = 'start'
  } else {
    y = cy + halfH + GAP + size * 0.72
  }

  return {
    x,
    y,
    textAnchor,
    style: { fontSize: node.options?.labelSize },
    transform: rot ? `rotate(${-rot} ${cx} ${cy})` : undefined,
  }
}

/**
 * The caption: the small dim legend inside a utility symbol's face (the tag id
 * over a counter, the table name over a table). It used to be a fixed 10px at
 * a fixed offset while the band it sits in scaled with the box, so a tall box
 * got a speck of text in a wide strip and a short one got text spilling over
 * its own top edge.
 *
 * Returns the font size in px, or null when the admin has hidden it. `auto` is
 * the symbol's size for its current box; `width` is the room the text has, and
 * the automatic size shrinks to fit it. An explicit `captionSize` is honoured
 * as set — someone who asked for 16px wants 16px.
 */
export function captionFont(node, { auto, width, text }) {
  if (node.options?.captionHidden) return null
  const set = node.options?.captionSize
  if (set != null) return set
  // Display face, uppercase, 0.12em tracking: ~0.72em per character.
  const fit = text ? width / (String(text).length * 0.72) : Infinity
  return Math.max(6, Math.min(auto, fit))
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * The frame a readout symbol draws its face in.
 *
 * The canvas rotates the whole symbol, which is right for plant — a pump turned
 * 180° should point the other way — and wrong for a readout: a counter turned
 * to put its port on the right would otherwise show its caption upside down in
 * the bottom-right corner, and its digits upside down too.
 *
 * At a quarter turn the face is laid out for the box the operator actually sees
 * (width and height swapped at 90°/270°) and counter-rotated into the node's
 * frame, so the body covers the same area while every line of text reads
 * upright and the caption stays top-left. Any other angle is a deliberate tilt
 * and is left alone.
 *
 * @returns {{ w: number, h: number, transform?: string }}
 */
export function uprightFrame(node) {
  const { w, h } = node
  const rot = ((Math.round(node.rot || 0) % 360) + 360) % 360
  if (rot === 0 || rot % 90 !== 0) return { w, h }
  const swap = rot === 90 || rot === 270
  const fw = swap ? h : w
  const fh = swap ? w : h
  return {
    w: fw,
    h: fh,
    transform: `rotate(${-rot} ${w / 2} ${h / 2}) translate(${(w - fw) / 2} ${(h - fh) / 2})`,
  }
}
