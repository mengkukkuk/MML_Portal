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

/**
 * Tags currently in alarm — variables_tag rows with a non-null alarm_no, joined to
 * the triggering alarm_logs row. Empty array when nothing is active.
 */
export async function fetchActiveAlarms() {
  const { data } = await apiClient.get('/alarms/active')
  return data // [{ alarm_id, location, tag_name, alarm, alarm_value, alarm_no,
  //               alarm_active, severity, at_date_time }]
}

/** Mark one alarm acknowledged. Returns the updated row. */
export async function acknowledgeAlarm(id) {
  const { data } = await apiClient.post(`/alarms/${id}/acknowledge`)
  return data
}
