import { apiClient } from './client'

/**
 * Dashboard API — named boards that group Live panels (dashboard_panels.dashboard_id).
 * Mirrors the /api/dashboards router in scada-mml-backend/dashboards.py.
 * Reads are open to any user; writes require an admin token (enforced server-side).
 */

export async function fetchDashboards() {
  const { data } = await apiClient.get('/dashboards')
  return data // [{ id, title, position, created_at }]
}

export async function createDashboard(dashboard) {
  const { data } = await apiClient.post('/dashboards', dashboard)
  return data
}

export async function updateDashboard(id, dashboard) {
  const { data } = await apiClient.put(`/dashboards/${id}`, dashboard)
  return data
}

export async function deleteDashboard(id) {
  await apiClient.delete(`/dashboards/${id}`)
}
