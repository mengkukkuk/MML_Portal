import { apiClient } from './client'

/**
 * Alert message API — mirrors /api/alerts in scada-mml-backend/alert_messages.py.
 *
 * There is one *source*: the connection, table and columns the plant's alert
 * messages are kept in, shared by every trend whichever connection it plots.
 * Any user may read it; saving and removing are admin-only, enforced
 * server-side. It may name a table that does not exist yet — every read
 * reports `available` and, when false, a `reason` ('missing' | 'unreachable' |
 * 'error') with a one-line `detail`.
 */

export async function fetchAlertSource() {
  const { data } = await apiClient.get('/alerts/source')
  return data // { configured, datasource_id, datasource_name, table_name, …, available, reason, detail }
}

export async function saveAlertSource(source) {
  const { data } = await apiClient.put('/alerts/source', source)
  return data
}

export async function deleteAlertSource() {
  await apiClient.delete('/alerts/source')
}

/**
 * The messages in [start, end] (ISO strings with an offset), newest first.
 *
 * `locations` / `cameras` are the report filter bar's picks; the backend applies
 * whichever one the source follows. "Nothing to show" is never thrown: an
 * unconfigured or unreadable source resolves with `available: false`.
 */
export async function fetchAlertMessages({
  start, end, locations = [], cameras = [], signal,
}) {
  const params = new URLSearchParams({ start, end })
  locations.forEach((l) => params.append('location', l))
  cameras.forEach((c) => params.append('camera', c))
  const { data } = await apiClient.get('/alerts/messages', { params, signal })
  return data // { configured, available, reason, detail, match_filter, messages: [{ ts, message, severity, severity_raw, role: { code, name_th, name_en } | null }], truncated }
}

/**
 * Response roles — who has to act on an alert. Each row is one rule: a role
 * (code, Thai and English names, and the `role_id` an alert row is tagged with)
 * and an optional location condition, tried by `priority`, first match wins.
 * Reading is open; writing is admin-only. Saving a `role_id` another role
 * already has is a 409.
 */
export async function fetchResponseRoles() {
  const { data } = await apiClient.get('/alerts/roles')
  return data // [{ id, role_id, code, name_th, name_en, location, priority, updated_at }]
}

export async function createResponseRole(role) {
  const { data } = await apiClient.post('/alerts/roles', role)
  return data
}

export async function updateResponseRole(id, role) {
  const { data } = await apiClient.put(`/alerts/roles/${id}`, role)
  return data
}

export async function deleteResponseRole(id) {
  await apiClient.delete(`/alerts/roles/${id}`)
}
