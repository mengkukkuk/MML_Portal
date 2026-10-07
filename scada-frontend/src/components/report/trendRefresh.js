/**
 * How often the signal trend re-reads, derived from the global poll interval
 * (Settings → Default poll interval) — pure, so it is unit-tested
 * (trendRefresh.test.js).
 *
 * The preference is a cadence for *live readings*. The trend re-reads a whole
 * window each time, which for a day or a season is far more than a poll, so the
 * interval is stretched on the long windows rather than hammering the plant
 * database every few seconds for a picture that hardly moves between ticks.
 * The effective interval is shown on the Live control, so the stretch is never
 * a surprise.
 */

const DAY_MS = 86_400_000

/** Milliseconds between refreshes for a window `windowMs` long. */
export function trendRefreshMs(pollSeconds, windowMs) {
  const base = Math.max(1, Number(pollSeconds) || 5) * 1000
  const floor = windowMs > 7 * DAY_MS ? 60_000 : windowMs > DAY_MS ? 15_000 : 0
  return Math.max(base, floor)
}

/** The window's length: minutes for a relative window, end − start for a custom one. */
export function windowSpanMs(trend) {
  if (trend.minutes === 'custom') return Date.parse(trend.end) - Date.parse(trend.start)
  return Number(trend.minutes) * 60_000
}

/** 5000 → "5 s", 60000 → "1 min". */
export function formatEvery(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}
