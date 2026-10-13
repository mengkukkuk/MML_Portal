// Pure view maths for CameraLightbox's zoom / pan stage.
//
// A view is { scale, x, y }: the image is drawn at its natural size, scaled
// about its top-left corner, then translated by (x, y) in stage pixels. Every
// function returns a fresh, already-clamped view so the component never has to
// reason about edges.

export const MAX_SCALE = 8
export const ZOOM_STEP = 1.25

const finite = (n) => Number.isFinite(n) && n > 0

/** Scale at which the whole frame fits the stage. Never enlarges a small frame. */
export function fitScale(natural, box) {
  if (!natural || !box || !finite(natural.w) || !finite(natural.h) || !finite(box.w) || !finite(box.h)) return 1
  return Math.min(1, box.w / natural.w, box.h / natural.h)
}

/** Fit is the floor (can't zoom out past "whole frame"); MAX_SCALE is the ceiling. */
export function clampScale(scale, natural, box) {
  const min = fitScale(natural, box)
  return Math.min(Math.max(MAX_SCALE, min), Math.max(min, scale))
}

function clampAxis(offset, scaledSize, boxSize) {
  // Smaller than the stage: pin to the centre. Larger: the image edge may not
  // pull away from the stage edge, so no empty gutter opens up while panning.
  if (scaledSize <= boxSize) return (boxSize - scaledSize) / 2
  return Math.min(0, Math.max(boxSize - scaledSize, offset))
}

export function clampView(view, natural, box) {
  const scale = clampScale(view.scale, natural, box)
  return {
    scale,
    x: clampAxis(view.x, natural.w * scale, box.w),
    y: clampAxis(view.y, natural.h * scale, box.h),
  }
}

/** Whole frame, centred. */
export function fitView(natural, box) {
  return clampView({ scale: fitScale(natural, box), x: 0, y: 0 }, natural, box)
}

/** Zoom to `scale`, keeping the image point under stage pixel (px, py) still. */
export function zoomAt(view, natural, box, scale, px, py) {
  const next = clampScale(scale, natural, box)
  const ratio = next / view.scale
  return clampView({
    scale: next,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
  }, natural, box)
}

/** Natural pixels (100 %), centred on stage pixel (px, py) of the current view. */
export function actualView(view, natural, box, px = box.w / 2, py = box.h / 2) {
  return zoomAt(view, natural, box, 1, px, py)
}

export function panBy(view, natural, box, dx, dy) {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, natural, box)
}

/** Distance and midpoint of two pointers, for pinch-to-zoom. */
export function pinchMetrics(a, b) {
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  }
}

export const isFitted = (view, natural, box) => (
  Math.abs(view.scale - fitScale(natural, box)) < 1e-6
)

export const percentLabel = (scale) => `${Math.round(scale * 100)}%`
