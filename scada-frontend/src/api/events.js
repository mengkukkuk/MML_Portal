import { apiClient } from './client'

/**
 * Last `limit` events per (location, tag_name) from public.event_logs, newest
 * first. Returns a flat array — the page groups it by location -> tag_name.
 */
export async function fetchRecentEvents(limit = 10) {
  const { data } = await apiClient.get('/events/recent', { params: { limit } })
  return data // [{ location, tag_name, event, at_date_time }]
}
