import { apiClient } from './client'

/**
 * Dashboard API — named boards that group Live panels (dashboard_panels.dashboard_id).
 * Mirrors the /api/dashboards router in scada-mml-backend/dashboards.py.
 * Reads are open to any user; writes require an admin token (enforced server-side).
 */

export async function fetchDashboards() {
  const { data } = await apiClient.get('/dashboards')
  return data // [{ id, title, position, page_count, created_at }]
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

/** How many pages the board has (the Live page's arrows); admin only. */
export async function setDashboardPages(id, pageCount) {
  const { data } = await apiClient.patch(`/dashboards/${id}/pages`, { page_count: pageCount })
  return data
}
