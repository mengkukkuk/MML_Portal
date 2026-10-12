/**
 * The balloon's outline — pure, so the geometry is unit-tested
 * (bubbleShape.test.js) and shared by the drawing, the editor's drag handle and
 * its drag bounds, which all have to agree on how big the balloon is.
 *
 * Four plain shapes. The circle is the ISA-5.1 convention and stays the default;
 * the others exist because a long reading ("123,456,780.0") does not fit a
 * circle, and a wide box or a pill gives it room without making the whole
 * balloon bigger.
 *
 * Everything is derived from one `radius` (the admin's size setting), because
 * the text inside was hand-tuned around a 34-unit circle and scales with it.
 */

export const BUBBLE_SHAPES = [
  { id: 'circle', label: 'Circle' },
  { id: 'square', label: 'Square' },
  { id: 'box', label: 'Box' },
  { id: 'pill', label: 'Pill' },
]

export const DEFAULT_BUBBLE_SHAPE = 'circle'

/** The circle the text rows were hand-tuned around; every size scales from it. */
export const BUBBLE_BASE_RADIUS = 34

// Measured, not guessed, on the base circle in the sans face: the value is drawn
// at 15 units and 13 characters ("123,456,780.0") run 104 of them; the tag above
// it is 11 units with letter-spacing, and 16 characters run 124.
const VALUE_FONT = 15
const VALUE_CHAR_EM = 0.56
const TAG_FONT = 11
const TAG_CHAR_EM = 0.7
// Clear space either side of the widest row. It also has to cover the curve of a
// pill's end, which bites in furthest on the tag row near the top.
const TEXT_MARGIN = 12

/**
 * Width, in base-circle units, of the wider of the two rows a balloon prints —
 * the reading and the tag above it — so a long loop id widens the outline as
 * surely as a long number does.
 */
export function bubbleTextWidth(valueText = '', tagText = '') {
  return Math.max(valueText.length * VALUE_CHAR_EM * VALUE_FONT, tagText.length * TAG_CHAR_EM * TAG_FONT)
}

/** The stored shape, or the default when it is missing or not one we know. */
export function bubbleShape(options) {
  const id = options?.bubbleShape
  return BUBBLE_SHAPES.some((s) => s.id === id) ? id : DEFAULT_BUBBLE_SHAPE
}

/** Whether an admin has switched this symbol's balloon off. */
export function bubbleHidden(node) {
  return node?.options?.bubbleHidden === true
}

/**
 * Half-width, half-height and corner radius of the outline, in logical units.
 *
 * The wide shapes are shorter than the circle is tall (0.85 × radius) so the
 * balloon grows sideways, where the number needs the room, and not upwards over
 * the equipment it belongs to. The text rows still fit: the unit sits 24 units
 * below centre at the default size, inside the 28.9 a box reaches.
 *
 * `textWidth` is what bubbleTextWidth() says the balloon prints. A box or a pill
 * is never narrower than its base width, but widens past it for long text —
 * which is the reason to pick one. The circle and the square keep their size:
 * they are the choice for short readings, and their silhouette is the point.
 */
export function bubbleGeometry(shape, radius, textWidth = 0) {
  const wide = () => {
    const scale = radius / BUBBLE_BASE_RADIUS
    return Math.max(radius * 1.6, (textWidth / 2 + TEXT_MARGIN) * scale)
  }
  switch (shape) {
    case 'square': return { hw: radius, hh: radius, rx: radius * 0.2 }
    case 'box': return { hw: wide(), hh: radius * 0.85, rx: radius * 0.16 }
    case 'pill': return { hw: wide(), hh: radius * 0.85, rx: radius * 0.85 }
    default: return { hw: radius, hh: radius, rx: radius }
  }
}

/**
 * How far the hairline between tag and value stops short of each edge. A
 * rounded outline curves away from the line, so it is inset; a square one is
 * met flush.
 */
export function bubbleSplitInset(shape, scale) {
  return shape === 'square' || shape === 'box' ? 0 : 3 * scale
}
