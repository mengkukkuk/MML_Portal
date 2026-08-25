import { apiClient } from './client'

/**
 * Last `limit` events per (location, tag_name), newest first, merged across every
 * selected data source. Each row carries `datasource_id` / `datasource_name`,
 * because two plants routinely use the same location and tag names and the rows
 * are otherwise indistinguishable.
 *
 * Returns { events, sources }. `sources` reports one entry per selected source
 * with `ok` and `error`, so "no events" and "no events because that plant is
 * unreachable" stay distinguishable — without it a dead plant looks like a quiet
 * one.
 */
export async function fetchRecentEvents(limit = 10) {
  const { data } = await apiClient.get('/events/recent', { params: { limit } })
  return {
    events: data.events ?? [],
    sources: data.sources ?? [],
  }
}
