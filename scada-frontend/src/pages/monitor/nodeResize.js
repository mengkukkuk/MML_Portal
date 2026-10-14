/**
 * Resizing a symbol that may be rotated.
 *
 * A node is stored as an upright box (x, y, w, h) plus `rot`, and the canvas
 * draws it `rotate(rot)` about the box centre. Growing `w` therefore moves the
 * centre, and with it every edge of the rotated drawing — so the old approach of
 * nudging x/y/w/h as if the box were upright made the edge you were *not*
 * holding slide across the sheet as soon as a symbol was turned.
 *
 * This works the way a drawing tool does instead: the grip opposite the one you
 * hold is pinned to its spot on the sheet, the grip you hold follows the
 * pointer (snapped to the sheet grid when the box is square to it), and x/y are
 * solved afterwards so the pinned grip has not moved.
 */

export const MIN_NODE = 24

const rad = (deg) => (deg * Math.PI) / 180
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Rotation folded into 0–359. */
export const normRot = (rot) => ((Math.round(rot || 0) % 360) + 360) % 360

/** Rotate a vector by `deg`. */
function turn([u, v], deg) {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return [u * c - v * s, u * s + v * c]
}

/** Sheet position of a point given as fractions of the node's own box. */
export function boxPoint({ x, y, w, h, rot }, fx, fy) {
  const [ox, oy] = turn([(fx - 0.5) * w, (fy - 0.5) * h], rot || 0)
  return { x: x + w / 2 + ox, y: y + h / 2 + oy }
}

/** Half-extents of the rotated box's sheet-aligned bounding box. */
export function rotatedHalf(w, h, rot) {
  const c = Math.abs(Math.cos(rad(rot || 0)))
  const s = Math.abs(Math.sin(rad(rot || 0)))
  return { hw: (w * c + h * s) / 2, hh: (w * s + h * c) / 2 }
}

/**
 * Range for a node's x/y that keeps everything it draws on the sheet. For an
 * upright node this is the familiar [0, sheet - w]; turned, it is the rotated
 * box's footprint that has to fit.
 */
export function positionBounds(node, sheet) {
  const { hw, hh } = rotatedHalf(node.w, node.h, node.rot)
  return {
    minX: hw - node.w / 2,
    maxX: sheet.w - node.w / 2 - hw,
    minY: hh - node.h / 2,
    maxY: sheet.h - node.h / 2 - hh,
  }
}

/** True when the rotated box lies entirely on the sheet (with a hair of slack). */
function fits(box, sheet) {
  const { hw, hh } = rotatedHalf(box.w, box.h, box.rot)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const e = 0.01
  return cx - hw >= -e && cy - hh >= -e && cx + hw <= sheet.w + e && cy + hh <= sheet.h + e
}

/**
 * The cursor for a grip, picked from the direction it actually points on the
 * sheet. A corner grip on a symbol turned 90° is a ↗ grip, not a ↘ one.
 */
export function gripCursor(handle, rot) {
  const [dx, dy] = turn([handle.fx - 0.5, handle.fy - 0.5], rot || 0)
  // Direction folded into a half-turn: the two ends of one axis share a cursor.
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180
  const bucket = Math.round(deg / 45) % 4
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][bucket]
}

/**
 * The box a resize drag has arrived at.
 *
 * `drag` holds the box as it was when the grip was grabbed (x0, y0, w0, h0,
 * rot) and the grip itself; `dx`/`dy` are the pointer's travel on the sheet
 * since then. Measured from the start rather than accumulated, so a drag that
 * wanders out to the sheet edge and back comes home to where it began.
 *
 * Snapping puts the grip you hold on a sheet grid line — only when the box is
 * square to the grid (a quarter turn), because at 30° no edge of it can sit on
 * one. A tilted box snaps its width and height to whole grid steps instead.
 *
 * @param {object} drag
 * @param {number} dx sheet units
 * @param {number} dy sheet units
 * @param {boolean} lockAspect Shift on a corner keeps the proportions
 * @param {boolean} snapEnabled
 * @param {{ w: number, h: number }} sheet
 * @param {number} grid grid step in sheet units
 */
export function resizeBox(drag, dx, dy, lockAspect, snapEnabled, sheet, grid) {
  const {
    x0, y0, w0, h0, handle,
  } = drag
  const rot = drag.rot || 0
  const start = { x: x0, y: y0, w: w0, h: h0, rot }
  const square = normRot(rot) % 90 === 0
  const snap = (v) => (snapEnabled ? Math.round(v / grid) * grid : v)

  // Where the held grip should now be, on the sheet.
  const held0 = boxPoint(start, handle.fx, handle.fy)
  let hx = held0.x + dx
  let hy = held0.y + dy
  if (snapEnabled && square) {
    hx = snap(hx)
    hy = snap(hy)
  }

  // Its travel, read back along the box's own axes: u along width, v along
  // height. Only the edges this grip owns may use it.
  const [du, dv] = turn([hx - held0.x, hy - held0.y], -rot)
  const sx = handle.ex === 'l' ? -1 : handle.ex === 'r' ? 1 : 0
  const sy = handle.ey === 't' ? -1 : handle.ey === 'b' ? 1 : 0

  // Whole units: the size readout and the saved layout both deal in them.
  let w = sx ? Math.max(MIN_NODE, Math.round(w0 + sx * du)) : w0
  let h = sy ? Math.max(MIN_NODE, Math.round(h0 + sy * dv)) : h0
  if (snapEnabled && !square) {
    if (sx) w = Math.max(MIN_NODE, snap(w))
    if (sy) h = Math.max(MIN_NODE, snap(h))
  }

  // Width leads, because the pointer travels further sideways on almost every
  // corner drag.
  if (lockAspect && sx && sy && w0 > 0) h = Math.max(MIN_NODE, Math.round((w * h0) / w0))

  // The grip opposite the held one stays put. For an edge grip that is the
  // middle of the opposite edge, which keeps the box centred along that edge.
  const ax = sx ? (1 - handle.fx) : 0.5
  const ay = sy ? (1 - handle.fy) : 0.5
  const pin = boxPoint(start, ax, ay)
  const place = (bw, bh) => {
    const [ox, oy] = turn([(ax - 0.5) * bw, (ay - 0.5) * bh], rot)
    return { x: pin.x - ox - bw / 2, y: pin.y - oy - bh / 2, w: bw, h: bh, rot }
  }

  let box = place(w, h)
  if (!fits(box, sheet)) box = backOff(start, { w, h }, place, sheet, lockAspect)
  return { x: box.x, y: box.y, w: box.w, h: box.h }
}

/**
 * Shrink a resize that would push the symbol off the sheet back to the largest
 * size that still fits, between where the drag started and where it was
 * heading. Each axis backs off on its own, so dragging a corner past the right
 * edge still lets the height follow the pointer — unless the proportions are
 * locked, when both give way together.
 */
function backOff(start, target, place, sheet, lockAspect) {
  const search = (make) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2
      if (fits(make(mid), sheet)) lo = mid
      else hi = mid
    }
    return lo
  }
  const lerp = (a, b, t) => a + (b - a) * t

  if (lockAspect) {
    const t = search((k) => place(lerp(start.w, target.w, k), lerp(start.h, target.h, k)))
    return place(Math.round(lerp(start.w, target.w, t)), Math.round(lerp(start.h, target.h, t)))
  }
  const tw = search((k) => place(lerp(start.w, target.w, k), start.h))
  const w = clamp(Math.floor(lerp(start.w, target.w, tw)), MIN_NODE, Infinity)
  const th = search((k) => place(w, lerp(start.h, target.h, k)))
  const h = clamp(Math.floor(lerp(start.h, target.h, th)), MIN_NODE, Infinity)
  return place(w, h)
}
