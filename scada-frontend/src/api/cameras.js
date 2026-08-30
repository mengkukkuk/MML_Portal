import { apiClient } from './client'

/**
 * Camera API — backs the /monitor camera detail rail.
 * Mirrors the /api/cameras router in scada-mml-backend/cameras.py.
 *
 * Camera identity and defect batches come from the saved datasource selected
 * in Settings. Mimic nodes persist the stable camera `code`, never a database
 * serial id.
 */

/**
 * Which saved connection backs the Monitor "Linked to" camera picker.
 * A null id means Monitor cameras are not configured yet; there is no local
 * camera-table fallback.
 */
export async function fetchCameraLinkSource() {
  const { data } = await apiClient.get('/cameras/link-source')
  return data // { datasource_id, datasource_name }
}

/** Admin only — designate the required camera datasource. */
export async function updateCameraLinkSource(datasourceId) {
  const { data } = await apiClient.put('/cameras/link-source', { datasource_id: datasourceId })
  return data // { datasource_id, datasource_name }
}

/**
 * Candidate cameras for the link picker, filtered by position (`location`)
 * and `code` — read live from the designated datasource's own `cameras` table.
 */
export async function fetchCameraLinkOptions() {
  const { data } = await apiClient.get('/cameras/link-options')
  return data // { source: 'datasource', datasource_id, datasource_name, cameras: [...] }
}

/**
 * The newest batch of defect counts for a source-resolved camera code — drives
 * the rail's bars without relying on a serial id from the app database.
 * `batch_id: null` means nothing has ever been recorded for this camera, which
 * the rail shows differently from a batch that counted zero.
 */
export async function fetchCameraDefects(cameraCode) {
  const code = encodeURIComponent(cameraCode)
  const { data } = await apiClient.get(`/cameras/linked/${code}/defects`)
  return data // { batch_id, updated_at, total, slots: [{ slot, label, count, has_frames }] }
}

/**
 * Frames stored on disk for one defect slot, newest first.
 * Empty — never an error — on an install with no image folder configured.
 */
export async function fetchCameraDefectFrames(cameraCode, slot, { limit = 30 } = {}) {
  const code = encodeURIComponent(cameraCode)
  const { data } = await apiClient.get(`/cameras/linked/${code}/defects/${slot}/frames`, {
    params: { limit },
  })
  return data // [{ index, captured_at, size_bytes, mtime_ns }]
}
