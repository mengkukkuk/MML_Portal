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
 * The film strip shows one of two things: rejects for a single defect slot, or
 * the camera's passing frames. `OK_SLOT` is the sentinel for the latter.
 *
 * It travels through the rail's filter state, the blob-cache key and the image
 * URL, which keeps the two cases on one code path instead of two parallel ones.
 * A string can never collide with a slot number, so `slot === OK_SLOT` is an
 * unambiguous test everywhere it is made.
 */
export const OK_SLOT = 'ok'

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

/** Passing frames for one camera. Not split by slot — an OK capture has no defect. */
export async function fetchCameraOkFrames(cameraCode, { limit = 30 } = {}) {
  const code = encodeURIComponent(cameraCode)
  const { data } = await apiClient.get(`/cameras/linked/${code}/ok/frames`, {
    params: { limit },
  })
  return data // [{ index, captured_at, size_bytes, mtime_ns }]
}

/** Whichever listing `slot` names — a defect slot number, or OK_SLOT. */
export function fetchCameraFrames(cameraCode, slot, options) {
  return slot === OK_SLOT
    ? fetchCameraOkFrames(cameraCode, options)
    : fetchCameraDefectFrames(cameraCode, slot, options)
}

/**
 * Where one frame's bytes live. Kept here rather than in the blob-cache hook so
 * every path this module's router serves is described in one file.
 */
export function cameraFrameImagePath(cameraCode, slot, index) {
  const code = encodeURIComponent(cameraCode)
  return slot === OK_SLOT
    ? `/cameras/linked/${code}/ok/frames/${index}/image`
    : `/cameras/linked/${code}/defects/${slot}/frames/${index}/image`
}
