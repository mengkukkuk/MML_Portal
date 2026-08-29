export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4
export const GRID_UNIT = 8

/**
 * Keep the visible drafting grid useful as the canvas zoom changes.
 *
 * Each level remains aligned to the real 8-unit snap grid, but doubles its
 * visible interval when zooming out so guides never collapse into a dark
 * screen texture. Zooming in reveals the finer levels again.
 */
export function gridStepForZoom(zoom, unit = GRID_UNIT) {
  if (!Number.isFinite(zoom) || zoom <= 0) return unit * 2
  const level = Math.min(3, Math.max(0, Math.round(Math.log2(2 / zoom))))
  return unit * (2 ** level)
}

export const snapValue = (value, enabled, unit = GRID_UNIT) => (
  enabled ? Math.round(value / unit) * unit : value
)

export function zoomAtPoint(view, pointerX, pointerY, factor, baseWidth = 1600) {
  const nextW = Math.min(baseWidth / MIN_ZOOM, Math.max(baseWidth / MAX_ZOOM, view.w / factor))
  const applied = view.w / nextW
  const nextH = view.h / applied
  const rx = (pointerX - view.x) / view.w
  const ry = (pointerY - view.y) / view.h
  return {
    x: pointerX - rx * nextW,
    y: pointerY - ry * nextH,
    w: nextW,
    h: nextH,
  }
}

export function fitToContents(nodes, aspect = 16 / 9, padding = 48, baseWidth = 1600) {
  if (!nodes.length) return { x: 0, y: 0, w: baseWidth, h: baseWidth / aspect }
  const left = Math.min(...nodes.map((n) => n.x)) - padding
  const top = Math.min(...nodes.map((n) => n.y)) - padding
  const right = Math.max(...nodes.map((n) => n.x + n.w)) + padding
  const bottom = Math.max(...nodes.map((n) => n.y + n.h)) + padding
  let w = right - left
  let h = bottom - top
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  if (w / h > aspect) h = w / aspect
  else w = h * aspect
  if (w < baseWidth / MAX_ZOOM) { w = baseWidth / MAX_ZOOM; h = w / aspect }
  if (w > baseWidth / MIN_ZOOM) { w = baseWidth / MIN_ZOOM; h = w / aspect }
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
