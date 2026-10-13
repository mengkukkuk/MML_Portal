/**
 * Where the IP camera's parts go — pure, so the arithmetic is unit-tested
 * (cameraLayout.test.js) and IpCamera.jsx only has to draw.
 *
 * The camera is drawn once, in a 110 × 80 reference box, and scaled *uniformly*
 * into whatever box the node has. Every other symbol stretches its geometry to
 * w × h, which is fine for a tank and wrong for a drawing with circles and a
 * lens in it: a camera resized to 216 × 168 would come out oval. The scale is the
 * smaller of the two ratios, and the drawing is centred in what is left over.
 *
 * Two things are not part of the drawing and have to be placed around it:
 *
 *  - the identity plate (IP + camera code), which hangs off the camera's
 *    underside and stays readable when the node is turned: flat for a camera
 *    lying down, reading upward for one standing up. A plate that stayed flat
 *    beside a standing camera swung out a plate-width to the side, and on a
 *    sheet where cameras hang a hand apart that put it behind the next camera.
 *    That flat placement is still there as a choice (`plateUpright`) for a
 *    sheet with room for it;
 *  - the title, which goes clear of the drawing on a side the camera is not
 *    looking at (see titleAbove): with its plate for a camera lying down, so
 *    the name and the code stay together — below at 0°, above when it is upside
 *    down — and at the bracket's end for one standing up. It used to sit under
 *    the *unrotated* box, so a camera turned 90° — most of them, on a line where
 *    they look down at a belt — had its name printed across its own lens, and
 *    one turned 180° had it across the camera from its plate.
 */

export const REF_W = 110
export const REF_H = 80

/** The camera's visual centre in the reference box: bracket to front glass. */
const HEAD = { x: 51, y: 40 }
/** How far the bracket reaches below the optical axis, and the bar above it. */
const HEAD_BELOW = 22.1
const HEAD_ABOVE = 24
/**
 * What the camera occupies in the reference box: the bracket bar to the edge of the field of view,
 * the top of the bar to the bottom of the bracket. A rectangle, because the title only has to
 * clear the extremes.
 */
const ENVELOPE = [
  [0.8, HEAD.y - HEAD_ABOVE], [REF_W, HEAD.y - HEAD_ABOVE],
  [REF_W, HEAD.y + HEAD_BELOW], [0.8, HEAD.y + HEAD_BELOW],
]

/** The identity plate: its height, and the clear space between it and the bracket. */
const PLATE_H = 12.6
const PLATE_GAP = 4

/**
 * How far above and below its baseline a title's plate reaches, in title heights — measured on a
 * 24-unit title as 45.3 and 31.2 — and the margin kept between that frame and the drawing.
 */
const TITLE_PLATE_REACH = 1.9
const TITLE_FRAME_BELOW = 1.3
const TITLE_CLEARANCE = 2
/**
 * The status line under the title sits 13 below its baseline and hangs 2.5 under its own, at a
 * size that does not follow the title's. Under a small title it is the lowest thing there.
 */
const TITLE_STATUS_BELOW = 15.5

export const PLATE_MIN_W = 58
const PLATE_MAX_W = 100
/** The IP cell, the divider and the margins around the code. */
const PLATE_CHROME = 19.5
/** One character of the code at 7 units in the sans face, with its tracking. */
const CODE_CHAR_W = 4.27

/**
 * How far the plate's text is turned on the sheet, in degrees: 0 when the camera lies on its
 * side, -90 (reading upward) when it stands up. Never upside down, and never a free angle —
 * the plate follows the nearer of the two axes, so it always sits square to the camera.
 */
export function plateTurn(rot) {
  const th = (rot * Math.PI) / 180
  return Math.abs(Math.sin(th)) > Math.abs(Math.cos(th)) + 1e-9 ? -90 : 0
}

/**
 * Whether the title goes above the drawing rather than below it.
 *
 * A camera lying down (its plate flat) keeps the title with the plate: below at 0°, above at 180°.
 * One standing up has its plate beside it, so the title goes to the bracket's end, away from the
 * lens: above at 90°, where the lens points down, and below at 270°, where it points up — the
 * side a line looking down at a belt would otherwise print it across. The title therefore only
 * changes sides twice in a turn, at 45° and at 225°.
 */
export function titleAbove(rot) {
  const th = (rot * Math.PI) / 180
  return plateTurn(rot) === 0 ? Math.cos(th) < 0 : Math.sin(th) > 0
}

/** The code's characters, counted as people see them rather than as UTF-16 units. */
const length = (code) => [...String(code ?? '')].length

/**
 * How wide the identity plate has to be for `code`.
 *
 * A fixed plate was drawn for `CAM001-13` and clips a longer code, so the plate
 * grows to fit — up to a limit, past which the code is squeezed instead
 * (`squeezedCodeWidth`) because a plate wider than the camera stops being a tag.
 */
export function plateWidth(code) {
  const wanted = PLATE_CHROME + length(code) * CODE_CHAR_W
  return Math.min(PLATE_MAX_W, Math.max(PLATE_MIN_W, wanted))
}

/** Set when the code is too long even for the widest plate: the width to squeeze it into. */
export function squeezedCodeWidth(code) {
  return PLATE_CHROME + length(code) * CODE_CHAR_W > PLATE_MAX_W
    ? PLATE_MAX_W - PLATE_CHROME
    : null
}

/**
 * @param {{ w: number, h: number, rot?: number, plateW?: number, labelSize?: number, plateUpright?: boolean }} node
 *   node box, rotation in degrees, plate width from `plateWidth`, the title's font size, and
 *   whether the plate stays flat at every angle instead of turning with the camera
 * @returns {{ k: number, ox: number, oy: number, plate: { x: number, y: number, turn: number }, labelY: number }}
 *   `k`, `ox`, `oy` place the reference drawing in the node box; `plate` is the plate's centre and
 *   `turn` how far its text is turned (see plateTurn); `labelY` is the title's baseline, below or
 *   above the drawing (see titleAbove). All are in the node's own (unrotated) frame — the frame
 *   the plate and the title are counter-rotated into.
 */
export function cameraLayout({
  w, h, rot = 0, plateW = PLATE_MIN_W, labelSize, plateUpright = false,
}) {
  const k = Math.min(w / REF_W, h / REF_H)
  const ox = (w - REF_W * k) / 2
  const oy = (h - REF_H * k) / 2

  const th = (rot * Math.PI) / 180
  const sin = Math.sin(th)
  const cos = Math.cos(th)

  // Where the camera's centre ends up once the node is turned, in reference units.
  const dx = HEAD.x - REF_W / 2
  const dy = HEAD.y - REF_H / 2
  const hx = REF_W / 2 + dx * cos - dy * sin
  const hy = REF_H / 2 + dx * sin + dy * cos

  // The plate sits on the camera's underside — straight "down" turned with the node.
  // That direction is square to the camera's axis, so the camera's extent along it is just
  // HEAD_BELOW. The plate is a rectangle turned by `turn`; relative to that direction its
  // extent is its half-width times |sin| of the angle between them plus its half-height times
  // |cos|. Reach out by both and the two cannot overlap, whatever the angle. An upright plate is
  // the same sum with the plate left flat: beside a standing camera that is the half-width, which
  // is why it swings out to the side.
  const turn = plateUpright ? 0 : plateTurn(rot)
  const between = ((turn - rot) * Math.PI) / 180
  const reach = HEAD_BELOW + PLATE_GAP
    + (plateW / 2) * Math.abs(Math.sin(between)) + (PLATE_H / 2) * Math.abs(Math.cos(between))
  const plateX = hx - sin * reach
  const plateY = hy + cos * reach

  // The title goes clear of the drawing as it is actually turned — not clear of the reference box,
  // which overstates a camera lying upside down by the empty strip under its bracket. Which side
  // is titleAbove()'s call; the drawing's extent on that side is its envelope and its plate.
  const cx = w / 2
  const cy = h / 2
  const turned = ([x, y]) => {
    const px = ox + k * x - cx
    const py = oy + k * y - cy
    return [cx + px * cos - py * sin, cy + px * sin + py * cos]
  }
  const envelopeY = ENVELOPE.map((corner) => turned(corner)[1])
  const turnRad = (turn * Math.PI) / 180
  const plateHalfH = (Math.abs(Math.sin(turnRad)) * (plateW / 2) + Math.abs(Math.cos(turnRad)) * (PLATE_H / 2)) * k
  const plateMidY = oy + k * plateY
  const drawingTop = Math.min(...envelopeY, plateMidY - plateHalfH)
  const drawingBottom = Math.max(...envelopeY, plateMidY + plateHalfH)

  // MimicCanvas paints a plate behind every title (the mimic-title-plate filter). Its frame reaches
  // about 1.9 title-heights above the baseline and 1.3 below it, so the baseline has to clear the
  // frame as well as the glyphs or the plate is printed across the camera.
  const size = labelSize ?? 12
  const labelY = titleAbove(rot)
    // Above, nothing holds the title down: it just clears the top of the drawing.
    ? drawingTop - TITLE_CLEARANCE - Math.max(size * TITLE_FRAME_BELOW, TITLE_STATUS_BELOW)
    // Below, never above where it has always been, 18 under the node box. That was enough while
    // the drawing stopped short of the bottom of its box; this one fills it, down to the plate.
    : Math.max(drawingBottom + Math.max(18, size * TITLE_PLATE_REACH + TITLE_CLEARANCE), h + 18)

  return {
    k,
    ox,
    oy,
    plate: { x: ox + k * plateX, y: oy + k * plateY, turn },
    labelY,
  }
}
