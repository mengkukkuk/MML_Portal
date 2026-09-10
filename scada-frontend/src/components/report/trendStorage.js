/**
 * trendStorage — remembers the last trend binding across a page reload.
 *
 * The binding already lives in the query string, which survives F5 but not
 * arriving at bare `/reports` from the sidebar. Losing it there means picking
 * the same table, reading and clock again on every visit, so the last one is
 * mirrored into localStorage and restored only when the URL asks for nothing.
 * A link with its own binding always wins: the URL stays the source of truth
 * and this is the fallback under it.
 *
 * Serialised through `paramsFromTrend`/`trendFromParams` rather than as JSON,
 * so a stored value is exactly a query string and gets the same whitelisting,
 * index parsing and clamping a shared link does. A hand-rolled shape would
 * drift from TREND_KEYS the first time one of them changes.
 */
import { paramsFromTrend, trendFromParams } from './trendParams'

const TREND_KEY = 'mml.report.trend'

/** The stored binding, or null when there is nothing usable to restore. */
export function readStoredTrend() {
  try {
    const raw = localStorage.getItem(TREND_KEY)
    if (!raw) return null
    const trend = trendFromParams(new URLSearchParams(raw))
    return trend.table ? trend : null
  } catch {
    return null
  }
}

export function writeStoredTrend(trend) {
  // A table-less trend is never something the user asked for — the Table select
  // offers no empty option — it is TrendRail clamping a binding the *current*
  // plant doesn't have. Persisting it would destroy the remembered binding for
  // the plant it did belong to, just from switching sources in the header.
  if (!trend?.table) return
  const params = paramsFromTrend(trend)
  // A custom window is two absolute timestamps. In a shared link that means
  // "this window" and is the whole point; as a remembered preference it means
  // reopening the page tomorrow onto last Tuesday afternoon, with nothing on
  // screen to say why the chart is empty. Relative windows age fine and stay.
  if (params.get('win') === 'custom') {
    params.delete('win')
    params.delete('tstart')
    params.delete('tend')
  }
  try {
    localStorage.setItem(TREND_KEY, params.toString())
  } catch {
    /* private mode / quota — remembering is a convenience, not a requirement */
  }
}
