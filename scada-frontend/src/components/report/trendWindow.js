export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000

export function windowError(start, end) {
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    return 'Choose a valid Start and End date/time.'
  }
  const duration = Date.parse(end) - Date.parse(start)
  if (duration <= 0) return 'End must be after Start.'
  if (duration > MAX_WINDOW_MS) return 'Choose a window of seven days or less.'
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
