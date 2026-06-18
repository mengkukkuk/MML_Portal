import { apiClient } from './client'

/**
 * Status-tag API — backs the live dashboard against public.status_tag.
 * Mirrors the /api/tags router in scada-mml-backend/tags.py.
 */

export async function fetchTags() {
  const { data } = await apiClient.get('/tags')
  return data // [{ tag_name }]
}

export async function fetchTagFields() {
  const { data } = await apiClient.get('/tags/fields')
  return data // [{ field, label }]
}

export async function fetchTagLatest(tagName) {
  const { data } = await apiClient.get('/tags/latest', { params: { tag_name: tagName } })
  return data // { tag_name, active, ts, current_value, current_setpoint, current_high_value, current_low_value }
}
