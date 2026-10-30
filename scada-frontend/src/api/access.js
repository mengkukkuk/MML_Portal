import { apiClient } from './client'

// The backend speaks naive server-local ISO timestamps (no zone suffix), the same
// convention as /api/reports. dayjs#format with this pattern keeps the browser's
// wall-clock digits rather than converting to UTC the way toISOString() would.
const NAIVE_ISO = 'YYYY-MM-DDTHH:mm:ss'

/** Monitor health: { enabled, running, since, interval_seconds, server_time, ports }. */
export async function fetchAccessStatus() {
  const { data } = await apiClient.get('/access/status')
  return data
}

/** Sessions open right now: { server_time, sessions }. Polled every few seconds. */
export async function fetchAccessActive() {
  const { data } = await apiClient.get('/access/active')
  return data
}

/**
 * Finished sessions overlapping [start, end] (dayjs values), newest first.
 * Returns { rows, total, truncated, files }. `total` is the true match count, so a
 * clipped list can say so instead of looking complete.
 */
export async function fetchAccessHistory({ start, end, protocol, q, limit } = {}) {
  const params = {}
  if (start) params.start = start.format(NAIVE_ISO)
  if (end) params.end = end.format(NAIVE_ISO)
  if (protocol) params.protocol = protocol
  if (q) params.q = q
  if (limit) params.limit = limit
  const { data } = await apiClient.get('/access/history', { params })
  return data
}
