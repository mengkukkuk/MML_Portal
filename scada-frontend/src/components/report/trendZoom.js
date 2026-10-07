/**
 * The signal trend's view — which slice of its window is on screen — as pure
 * arithmetic, so the zoom buttons, the drag-a-box tool and the live refresh all
 * agree on it and it can be unit-tested apart from ECharts (trendZoom.test.js).
 *
 * Two ranges are in play, both in epoch milliseconds:
 *   full  { from, to }          the whole window the data was read for
 *   view  { from, to, follow }  the zoomed slice, or null for "all of it"
 *
 * The view is held as *absolute times*, never as percentages. The window slides
 * forward on every live refresh, and a percentage would drift with it — the
 * thing you zoomed into would creep away under the cursor. `follow` marks a view
 * pinned to the newest edge (zoom into the last half hour and watch it move): it
 * keeps its span and rides the window's end instead of staying put in the past.
 */

export const ZOOM_STEP = 1.5

// A reading is never more often than this, so a narrower view is just a blur.
const MIN_SPAN_FLOOR_MS = 10_000
// How close to the window's end counts as "the newest edge".
const FOLLOW_SLACK_MS = 1000

const spanOf = (range) => range.to - range.from

/** The narrowest view allowed: a five-hundredth of the window, never under 10 s. */
export function minSpan(full) {
  return Math.max(MIN_SPAN_FLOOR_MS, Math.round(spanOf(full) / 500))
}

/**
 * Turn a range read off the chart into a view, or null when it is (to within a
 * thousandth) the whole window — so zooming all the way out lands back on "no
 * zoom" instead of leaving a view that merely looks like it.
 */
export function viewFromRange(range, full) {
  const eps = Math.max(1000, spanOf(full) * 0.001)
  if (range.from <= full.from + eps && range.to >= full.to - eps) return null
  const span = range.to - range.from
  const follow = range.to >= full.to - Math.max(FOLLOW_SLACK_MS, span * 0.01)
  return { from: range.from, to: range.to, follow }
}

/**
 * The view as it should be drawn against the *current* full window. Re-resolved
 * on every refresh: a followed view shifts with the window's end, a fixed one is
 * kept inside it (and dropped once it has slid out of it entirely).
 */
export function resolveView(view, full) {
  if (!view) return null
  const fullSpan = spanOf(full)
  const span = Math.min(view.to - view.from, fullSpan)
  let from
  if (view.follow) from = full.to - span
  else if (view.to <= full.from || view.from >= full.to) return null
  else from = Math.max(full.from, Math.min(view.from, full.to - span))
  return viewFromRange({ from, to: from + span }, full)
}

/**
 * Zoom by `factor` (> 1 in, < 1 out) around the view's centre — or its right
 * edge when it is following live data, so the newest reading stays on screen.
 */
export function zoomBy(view, full, factor) {
  const current = resolveView(view, full) ?? { from: full.from, to: full.to, follow: false }
  const fullSpan = spanOf(full)
  const span = Math.min(fullSpan, Math.max(minSpan(full), spanOf(current) / factor))
  const anchorAt = current.follow ? 1 : 0.5
  const anchor = current.from + spanOf(current) * anchorAt
  let from = anchor - span * anchorAt
  from = Math.max(full.from, Math.min(from, full.to - span))
  return viewFromRange({ from, to: from + span }, full)
}

/** A box dragged between two times. Too small to mean it is a click, not a zoom. */
export function selectionToView(t0, t1, full) {
  const from = Math.max(full.from, Math.min(t0, t1))
  const to = Math.min(full.to, Math.max(t0, t1))
  if (!(to - from >= minSpan(full))) return null
  return viewFromRange({ from, to }, full)
}

/** 100 when the whole window is showing, 400 when a quarter of it is. */
export function zoomPercent(view, full) {
  const shown = resolveView(view, full)
  return shown ? Math.round((spanOf(full) / spanOf(shown)) * 100) : 100
}

export const canZoomIn = (view, full) => {
  const shown = resolveView(view, full)
  return spanOf(shown ?? full) / ZOOM_STEP >= minSpan(full) * 0.999
}
export const canZoomOut = (view, full) => !!resolveView(view, full)

/**
 * ECharts `dataZoom` for the trend: wheel/pinch always zooms; dragging pans only
 * while the hand tool is on (otherwise the drag is the zoom box, drawn by the
 * stage). A slider joins past a week, where there is something to zoom into.
 */
export function buildDataZoom({ long, view, hand }) {
  const extent = view ? { startValue: view.from, endValue: view.to } : { start: 0, end: 100 }
  const inside = {
    type: 'inside',
    ...extent,
    moveOnMouseMove: !!hand,
    zoomOnMouseWheel: true,
    moveOnMouseWheel: false,
  }
  return long
    ? [inside, { type: 'slider', ...extent, height: 16, bottom: 4, brushSelect: false }]
    : [inside]
}
