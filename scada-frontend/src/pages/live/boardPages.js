/**
 * boardPages — a Live dashboard as several pages ("areas") the header's arrows
 * step through, so a board too tall for one screen becomes screens in a row.
 *
 * The dashboard says how many pages it has (`page_count`, dashboards.py); each
 * panel says which page it sits on in `options.page` (0-based, like
 * options.layout it rides in the panel's options). A panel with no page is on
 * the first; one past the last page — a page deleted elsewhere — is shown on
 * the last, so no rule here can make a panel unreachable.
 */

/** Auto-slide intervals a viewer can pick, in seconds. */
export const AUTOPLAY_SECONDS = [10, 20, 30, 60]
export const DEFAULT_AUTOPLAY_SECONDS = 20
export const MAX_PAGES = 12

/** The page `panel` sits on (0-based); no page, or a bad one, is the first. */
export function pageOf(panel) {
  const p = Number(panel?.options?.page)
  return Number.isInteger(p) && p > 0 ? p : 0
}

/** How many pages the board has, between 1 and MAX_PAGES. */
export function pageCount(dashboard) {
  const own = Number.isInteger(dashboard?.page_count) && dashboard.page_count > 0 ? dashboard.page_count : 1
  return Math.min(MAX_PAGES, Math.max(own, 1))
}

/** `page` kept inside a board of `count` pages. */
export function clampPage(page, count) {
  const p = Number.isInteger(page) ? page : 0
  return Math.max(0, Math.min(p, Math.max(1, count) - 1))
}

/** The panels shown on `page` — a panel past the last page counts as on the last. */
export function panelsOnPage(panels, page, count) {
  return (panels || []).filter((p) => clampPage(pageOf(p), count) === page)
}

/** Step `page` by `dir` through `count` pages, wrapping at the ends. */
export function stepPage(page, dir, count) {
  return count > 0 ? (((page + dir) % count) + count) % count : 0
}

/**
 * The moves deleting (empty) page `removed` needs: every panel on a later page
 * slides one page down, so the pages after it keep their order. [{panel, page}]
 */
export function shiftAfterRemoving(panels, removed, count) {
  return (panels || [])
    .filter((p) => clampPage(pageOf(p), count) > removed)
    .map((p) => ({ panel: p, page: clampPage(pageOf(p), count) - 1 }))
}

/** `?page=` (1-based, as people count) → a 0-based page, or null if absent or bad. */
export function pageFromQuery(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n - 1 : null
}

/**
 * Where a `w`×`h` panel fits on a page laid out as `layout` ([{x,y,w,h}]) in a
 * `cols`-wide grid: the first gap, scanning rows top to bottom and each row
 * left to right — so panels moved onto a page fill it side by side instead of
 * piling up in one column below everything else.
 */
export function firstFreeSlot(layout, w, h, cols = 12) {
  const width = Math.max(1, Math.min(w, cols))
  const items = layout || []
  const clash = (x, y) => items.some((it) => x < it.x + it.w && it.x < x + width && y < it.y + it.h && it.y < y + h)
  const bottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0)
  for (let y = 0; y <= bottom; y += 1) {
    for (let x = 0; x + width <= cols; x += 1) {
      if (!clash(x, y)) return { x, y, w: width, h }
    }
  }
  return { x: 0, y: bottom, w: width, h }
}
