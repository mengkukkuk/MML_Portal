/**
 * Resolution tiers for the signal trend — the arithmetic, apart from React and
 * ECharts so it can be tested on its own (trendDetail.test.js).
 *
 * The chart never asks "give me about N points of this range". That answer
 * depends on the range: zoom a little and every bucket moves, so the line
 * reshapes under the cursor, and an overview and a zoomed slice of the same
 * minute disagree. Instead it asks for a *step* from a fixed ladder, chosen
 * from how much time one pixel holds. Buckets sit on the epoch (schema.py), so
 * one step over one stretch of time is always the same points:
 *
 * - a zoom that stays inside a tier changes nothing but the axis;
 * - crossing a tier goes to buckets of half a pixel or less, where the first,
 *   lowest, highest and last row of each draw the same picture as every row —
 *   the change is in detail the screen could not show before, not in shape;
 * - zoomed far enough, the step is finer than the rows and every row comes back.
 *
 * A zoomed view is read as fixed **tiles** of a tier — a set number of buckets
 * each, on the epoch too — so panning re-reads only the tile coming into view,
 * zooming back to a tier already seen costs nothing, and the tiles on screen
 * stay drawn while the next tier's are on their way.
 */

/** Bucket sizes, in seconds. Each is a time a person reads naturally. */
export const STEP_LADDER = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10_800, 21_600, 43_200, 86_400,
]

// Two buckets per pixel: with four rows kept per bucket, finer than the screen
// can show, so the drawn shape is the shape every row would draw.
const BUCKETS_PER_PX = 2

// Buckets per tile. About one chart width at two buckets a pixel, so a view
// touches two or three tiles.
export const TILE_BUCKETS = 4096

// Read this much of the view's span beyond each edge, so a small pan is
// already on hand.
const PAD = 0.5

/** The tier for `spanMs` of time drawn across `plotPx` pixels. */
export function tierStep(spanMs, plotPx) {
  const target = spanMs / 1000 / (Math.max(plotPx, 200) * BUCKETS_PER_PX)
  return STEP_LADDER.find((s) => s >= target)
    ?? Math.ceil(target / 86_400) * 86_400
}

/**
 * How often the rows come, in seconds: the median gap between points that came
 * back row for row. Null for fewer than three points.
 */
export function cadenceOf(points) {
  if (!points || points.length < 3) return null
  const gaps = points.slice(1).map((p, i) => p.t - points[i].t).filter((g) => g > 0)
  if (!gaps.length) return null
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1] / 1000
}

/**
 * The finest tier worth asking for rows that come every `cadence` seconds.
 * Below it every tier returns the same rows, so stopping here keeps one cache
 * entry instead of re-reading identical tiles at 5 s, 2 s and 1 s.
 */
export function floorStep(cadence) {
  if (!(cadence > 0)) return STEP_LADDER[0]
  return STEP_LADDER.filter((s) => s <= cadence).at(-1) ?? STEP_LADDER[0]
}

/**
 * The tiles of tier `step` covering the view (padded) inside the window, in
 * time order. Each is `{ from, to, step }` in epoch ms, on a fixed grid — the
 * same tile whatever view asked for it, so it is cached once.
 */
export function tilesFor(view, full, step) {
  if (!view || !full || !(step > 0)) return []
  const span = view.to - view.from
  const lo = Math.max(full.from, view.from - span * PAD)
  const hi = Math.min(full.to, view.to + span * PAD)
  if (!(hi > lo)) return []
  const size = step * 1000 * TILE_BUCKETS
  const tiles = []
  for (let i = Math.floor(lo / size); i * size < hi; i += 1) {
    tiles.push({ from: i * size, to: (i + 1) * size, step })
  }
  return tiles
}

/**
 * The overview with `detail` in place of whatever it held inside `range`.
 * Both are `{ t, ... }` arrays in time order; the result is too.
 */
export function spliceDetail(overview, detail, range) {
  if (!detail || !range) return overview
  const before = overview.filter((p) => p.t < range.from)
  const after = overview.filter((p) => p.t >= range.to)
  return [...before, ...detail.filter((p) => p.t >= range.from && p.t < range.to), ...after]
}

/** "1 h", "30 min", "3 d" — a span in the unit it reads best in. */
export function spanLabel(ms) {
  const s = ms / 1000
  const fmt = (n, unit) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${unit}`
  if (s >= 86_400) return fmt(Math.round((s / 86_400) * 10) / 10, 'd')
  if (s >= 3600) return fmt(Math.round((s / 3600) * 10) / 10, 'h')
  if (s >= 60) return fmt(Math.round(s / 60), 'min')
  return fmt(Math.round(s), 's')
}
