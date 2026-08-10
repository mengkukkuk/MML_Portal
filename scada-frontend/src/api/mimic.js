import { apiClient } from './client'

/**
 * Mimic-layout API — backs /monitor's drawing.
 * Mirrors the /api/mimic router in scada-mml-backend/mimic.py.
 *
 * The server is the source of truth: a drawing is commissioned once by an
 * admin and every operator sees the same one. Reads are open to any
 * authenticated user; the PUT is admin-only and 403s for everyone else.
 */

export async function fetchMimicLayouts() {
  const { data } = await apiClient.get('/mimic/layouts')
  return data // [{ slug, name, updated_at }]
}

/**
 * One drawing. Throws with `response.status === 404` when the plant has never
 * been saved — a normal first-run outcome the caller answers with its seed.
 */
export async function fetchMimicLayout(slug) {
  const { data } = await apiClient.get(`/mimic/layouts/${encodeURIComponent(slug)}`)
  return data // { slug, name, doc, updated_at }
}

export async function saveMimicLayout(slug, name, doc) {
  const { data } = await apiClient.put(`/mimic/layouts/${encodeURIComponent(slug)}`, { name, doc })
  return data // { slug, name, doc, updated_at }
}
