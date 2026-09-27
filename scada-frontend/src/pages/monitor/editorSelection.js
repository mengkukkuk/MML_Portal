/**
 * Multi-selection geometry for the mimic editor — pure, so it is unit-tested
 * (editorSelection.test.js) apart from the canvas that uses it.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Ids of the nodes whose box overlaps a logical rectangle (any corner order). */
export function nodesInRect(nodes, a, b) {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  return nodes
    .filter((n) => n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0)
    .map((n) => n.id)
}

/**
 * Move a group by one shared delta, clamped so no member leaves the sheet.
 * The delta is limited by the members nearest each edge, so the group moves as
 * a rigid block — clamping each member on its own would squash them together
 * against the edge and lose the arrangement being moved.
 */
export function moveGroup(origins, dx, dy, sheet) {
  const minX = Math.min(...origins.map((o) => o.x))
  const minY = Math.min(...origins.map((o) => o.y))
  const maxR = Math.max(...origins.map((o) => o.x + o.w))
  const maxB = Math.max(...origins.map((o) => o.y + o.h))
  const cx = clamp(dx, -minX, sheet.w - maxR)
  const cy = clamp(dy, -minY, sheet.h - maxB)
  return origins.map((o) => ({ id: o.id, x: o.x + cx, y: o.y + cy }))
}
