import { apiClient } from './client'

/**
 * Dashboard-panel API — backs the admin-managed Live grid (LivePage).
 * Mirrors the /api/panels router in scada-mml-backend/panels.py.
 * Reads are open to any user; writes require an admin token (enforced server-side).
 */

export async function fetchPanels() {
  const { data } = await apiClient.get('/panels')
  return data // [{ id, title, device_id, metric, window_minutes, chart_type, position, created_at }]
}

export async function createPanel(panel) {
  const { data } = await apiClient.post('/panels', panel)
  return data
}

export async function updatePanel(id, panel) {
  const { data } = await apiClient.put(`/panels/${id}`, panel)
  return data
}

export async function deletePanel(id) {
  await apiClient.delete(`/panels/${id}`)
}
