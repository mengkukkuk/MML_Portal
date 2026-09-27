// A year, plus a day so "same date last year" fits — mirrors MAX_SERIES_DAYS
// in schema.py. Past a week the server thins the readings to fit (see
// `sampled_seconds` on the series), so a year still draws the whole year.
export const MAX_WINDOW_MS = 366 * 24 * 60 * 60_000

// The trend's own window list. Live panels share the first six (their
// TIME_RANGES) but stop at a week; only this report chart reaches a year.
export const TREND_RANGES = [
  { value: 10, label: 'Last 10 min' },
  { value: 30, label: 'Last 30 min' },
  { value: 60, label: 'Last 1 hour' },
  { value: 480, label: 'Last 8 hours' },
  { value: 1440, label: 'Last 24 hours' },
  { value: 10080, label: 'Last week' },
  { value: 43200, label: 'Last 30 days' },
  { value: 129600, label: 'Last 90 days' },
  { value: 525600, label: 'Last 1 year' },
]

export function windowError(start, end) {
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    return 'Choose a valid Start and End date/time.'
  }
  const duration = Date.parse(end) - Date.parse(start)
  if (duration <= 0) return 'End must be after Start.'
  if (duration > MAX_WINDOW_MS) return 'Choose a window of one year or less.'
  return ''
}

export function resolveTrendWindow(trend, now = Date.now()) {
  if (trend.minutes === 'custom') return { start: trend.start, end: trend.end }
  // The pickers display minutes; keep the request equally precise.
  now = Math.floor(now / 60_000) * 60_000
  return {
    start: new Date(now - trend.minutes * 60_000).toISOString(),
    end: new Date(now).toISOString(),
  }
}

export function trendTimeAxis(range) {
  return { type: 'time', min: Date.parse(range.start), max: Date.parse(range.end) }
}
