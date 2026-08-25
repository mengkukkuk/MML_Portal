import { apiClient } from './client'

/**
 * Datasource API — admin-managed saved PostgreSQL connections that Live panels
 * can bind to. Mirrors the /api/datasources router in scada-mml-backend.
 * Reads are open to any user; writes + test require an admin token (enforced
 * server-side). Passwords are never returned — rows carry `has_password`.
 */

export async function fetchDatasources() {
  const { data } = await apiClient.get('/datasources')
  return data // [{ id, name, type, host, port, database, username, sslmode, has_password, created_at, updated_at }]
}

export async function createDatasource(ds) {
  const { data } = await apiClient.post('/datasources', ds)
  return data
}

export async function updateDatasource(id, ds) {
  const { data } = await apiClient.put(`/datasources/${id}`, ds)
  return data
}

export async function deleteDatasource(id) {
  await apiClient.delete(`/datasources/${id}`)
}

/**
 * Open a real connection and report the result. Pass raw fields, a saved
 * `datasource_id`, or both (fields override the saved row). Resolves to
 * { ok, message, server_version } even on failure (never throws on a bad
 * connection — only on transport/auth errors).
 */
export async function testDatasource(payload) {
  const { data } = await apiClient.post('/datasources/test', payload)
  return data
}

/**
 * The signed-in user's selected sources — which plants Live / Events / Alarms /
 * Monitor / Reports read from. Stored server-side per user, so it survives a new
 * browser and matches what the API is about to query.
 *
 * All three resolve to { selected: [{ id, name, host, database, position }],
 * implicit }. `implicit` means nobody chose anything and the backend fell back
 * to the first saved connection — the header renders that differently so a
 * default is not mistaken for a deliberate choice.
 */
export async function fetchSelection() {
  const { data } = await apiClient.get('/datasources/selection')
  return data
}

export async function saveSelection(datasourceIds) {
  const { data } = await apiClient.put('/datasources/selection', {
    datasource_ids: datasourceIds,
  })
  return data
}

export async function clearSelection() {
  const { data } = await apiClient.delete('/datasources/selection')
  return data
}
