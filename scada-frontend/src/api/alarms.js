import { apiClient } from './client'

/**
 * Last `limit` alarms per (location, tag_name) from public.alarm_logs, newest
 * first. Returns a flat array — the page groups by location -> tag_name.
 */
export async function fetchRecentAlarms(limit = 10) {
  const { data } = await apiClient.get('/alarms/recent', { params: { limit } })
  return data // [{ id, location, tag_name, alarm, severity, at_date_time,
  //               acknowledged, acknowledged_at, acknowledged_by }]
}

/** Mark one alarm acknowledged. Returns the updated row. */
export async function acknowledgeAlarm(id) {
  const { data } = await apiClient.post(`/alarms/${id}/acknowledge`)
  return data
}
