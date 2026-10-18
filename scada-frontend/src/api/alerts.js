import { apiClient } from './client'

/**
 * Alert message API — mirrors /api/alerts in scada-mml-backend/alert_messages.py.
 *
 * A *source* names where one datasource keeps its alert messages (table, time,
 * message, optional severity and match column). Any user may read it; saving
 * and removing are admin-only, enforced server-side. A source may name a table
 * that does not exist yet — every read reports `available` and, when false, a
 * `reason` ('missing' | 'unreachable' | 'error') with a one-line `detail`.
 */

export async function fetchAlertSource(datasourceId) {
  const { data } = await apiClient.get(`/alerts/sources/${datasourceId}`)
  return data // { datasource_id, configured, table_name, …, available, reason, detail }
}

export async function saveAlertSource(datasourceId, source) {
  const { data } = await apiClient.put(`/alerts/sources/${datasourceId}`, source)
  return data
}

export async function deleteAlertSource(datasourceId) {
  await apiClient.delete(`/alerts/sources/${datasourceId}`)
}

/**
 * The messages in [start, end] (ISO strings with an offset), newest first.
 *
 * `locations` / `cameras` are the report filter bar's picks; the backend applies
 * whichever one the source follows. "Nothing to show" is never thrown: an
 * unconfigured or unreadable source resolves with `available: false`.
 */
export async function fetchAlertMessages({
  datasourceId, start, end, locations = [], cameras = [], signal,
}) {
  const params = new URLSearchParams({ datasource_id: datasourceId, start, end })
  locations.forEach((l) => params.append('location', l))
  cameras.forEach((c) => params.append('camera', c))
  const { data } = await apiClient.get('/alerts/messages', { params, signal })
  return data // { configured, available, reason, detail, match_filter, messages: [{ ts, message, severity, severity_raw }], truncated }
}
