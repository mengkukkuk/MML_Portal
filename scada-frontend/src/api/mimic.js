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

export async function fetchMimicProductionLog(slug) {
  const { data } = await apiClient.get(
    `/mimic/layouts/${encodeURIComponent(slug)}/production-log`,
  )
  return data // { date, generated_at, current_hour, buckets, sources }
}

/**
 * Cameras reachable through this drawing's `doc.cameraDefect` binding.
 *
 * Under the mimic router rather than /api/cameras because the binding is what
 * says which table these come from, and the binding belongs to the drawing. A
 * second production line is a schema the vision system already provisioned plus
 * a binding pointing at it — no migration and no code change.
 *
 * 404s when the drawing has no binding yet, which is the state every layout is
 * in until an admin configures one.
 */
export async function fetchMimicCameras(slug) {
  const { data } = await apiClient.get(`/mimic/layouts/${encodeURIComponent(slug)}/cameras`)
  return data // [{ code, name, station }]
}

/**
 * The newest batch of defect counts for one camera, slot by slot.
 *
 * `batch_id: null` means nothing has ever been recorded for this camera, which
 * the rail shows differently from a batch that counted zero. The slot count
 * follows the binding's `defect_cols`, so a line grading six categories gets
 * six — the old fixed five are gone.
 */
export async function fetchMimicCameraDefects(slug, code) {
  const { data } = await apiClient.get(
    `/mimic/layouts/${encodeURIComponent(slug)}/cameras/${encodeURIComponent(code)}/defects`,
  )
  return data // { code, batch_id, updated_at, total, slots: [...], sources }
}

/**
 * Upsert. There is no PATCH: the whole document goes every time, so a rename
 * must send the existing `doc` back or it erases the drawing.
 */
export async function saveMimicLayout(slug, name, doc, baseUpdatedAt = undefined) {
  const body = { name, doc }
  if (baseUpdatedAt !== undefined) body.base_updated_at = baseUpdatedAt
  const { data } = await apiClient.put(`/mimic/layouts/${encodeURIComponent(slug)}`, body)
  return data // { slug, name, doc, updated_at }
}

export async function deleteMimicLayout(slug) {
  await apiClient.delete(`/mimic/layouts/${encodeURIComponent(slug)}`)
}
