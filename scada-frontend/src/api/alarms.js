import { apiClient } from './client'

/**
 * Alarm API — merged across every selected data source.
 *
 * Each row carries `datasource_id` / `datasource_name`, and each response also
 * carries `sources`: one entry per selected source with `ok` and `error`, so an
 * empty alarm list caused by an unreachable plant does not read as "all clear".
 */

/** Last `limit` alarms per (location, tag_name), newest first. */
export async function fetchRecentAlarms(limit = 10) {
  const { data } = await apiClient.get('/alarms/recent', { params: { limit } })
  return { alarms: data.alarms ?? [], sources: data.sources ?? [] }
}

/**
 * Tags currently in alarm — variables_tag rows with a non-null alarm_no, joined to
 * the triggering alarm_logs row.
 */
export async function fetchActiveAlarms() {
  const { data } = await apiClient.get('/alarms/active')
  return { alarms: data.alarms ?? [], sources: data.sources ?? [] }
}

/**
 * Mark one alarm acknowledged. Returns the updated row.
 *
 * `datasourceId` is required in practice, not optional: alarm ids come from each
 * database's own sequence, so id 42 exists in every plant and means something
 * different in each. Pass the `datasource_id` from the row the operator clicked
 * — omitting it acknowledges the first selected source's alarm 42, which is a
 * different alarm on a different machine.
 */
export async function acknowledgeAlarm(id, datasourceId) {
  const { data } = await apiClient.post(`/alarms/${id}/acknowledge`, null, {
    params: datasourceId != null ? { datasource_id: datasourceId } : undefined,
  })
  return data
}
