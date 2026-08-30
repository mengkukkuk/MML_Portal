import { apiClient } from './client'

/**
 * Camera API — backs the /monitor camera detail rail.
 * Mirrors the /api/cameras router in scada-mml-backend/cameras.py.
 *
 * A camera row is app config: an admin names a station's camera once, and a
 * mimic node reaches it by loop id (its `code`). Reads are open to any
 * authenticated user; writes — including snapshot uploads — are admin-only.
 */

export async function fetchCameras() {
  const { data } = await apiClient.get('/cameras')
  return data // [{ id, code, name, station_code, station_label, location, enabled, updated_at, defect_1_label…defect_5_label }]
}

export async function createCamera(body) {
  const { data } = await apiClient.post('/cameras', body)
  return data
}

/** Replaces the row whole — there is no PATCH, same as a mimic layout. */
export async function updateCamera(id, body) {
  const { data } = await apiClient.put(`/cameras/${id}`, body)
  return data
}

export async function deleteCamera(id) {
  await apiClient.delete(`/cameras/${id}`)
}

/**
 * Which saved connection backs the Monitor "Linked to" camera picker.
 * `datasource_id: null` means the picker reads this app's own `cameras`
 * table (the default) rather than a plant datasource's camera registry.
 */
export async function fetchCameraLinkSource() {
  const { data } = await apiClient.get('/cameras/link-source')
  return data // { datasource_id, datasource_name }
}

/** Admin only — designate (or clear, with `datasourceId: null`) the source. */
export async function updateCameraLinkSource(datasourceId) {
  const { data } = await apiClient.put('/cameras/link-source', { datasource_id: datasourceId })
  return data
}

/**
 * Candidate cameras for the link picker, filtered by position (`location`)
 * and `code` — read live from the designated datasource's own `cameras`
 * table, or from this app's own table when nothing is designated.
 */
export async function fetchCameraLinkOptions() {
  const { data } = await apiClient.get('/cameras/link-options')
  return data // { source: 'local'|'datasource', datasource_id, datasource_name, cameras: [...] }
}

/**
 * The newest batch of defect counts, slot by slot — drives the rail's bars.
 * `batch_id: null` means nothing has ever been recorded for this camera, which
 * the rail shows differently from a batch that counted zero.
 */
export async function fetchCameraDefects(cameraId) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/defects`)
  return data // { batch_id, updated_at, total, slots: [{ slot, label, count, has_frames }] }
}

/**
 * Frames stored on disk for one defect slot, newest first.
 * Empty — never an error — on an install with no image folder configured.
 */
export async function fetchCameraDefectFrames(cameraId, slot, { limit = 30 } = {}) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/defects/${slot}/frames`, {
    params: { limit },
  })
  return data // [{ index, captured_at, size_bytes, mtime_ns }]
}

/**
 * Snapshot metadata only — no bytes. Pass `cause` to filter.
 *
 * Retained deliberately although the rail no longer renders these: the upload
 * route below is the only way to get a frame *into* this system, and its
 * evidence would be unreachable without a reader.
 */
export async function fetchCameraSnapshots(cameraId, { limit = 30, cause } = {}) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/snapshots`, {
    params: { limit, cause: cause || undefined },
  })
  return data // [{ id, camera_id, captured_at, cause, verdict, mime, size_bytes }]
}

/** NG-frame counts by cause, most frequent first. See the note above. */
export async function fetchCameraCauseCounts(cameraId) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/causes`)
  return data // [{ cause, n }]
}

/**
 * Upload one frame. Admin only.
 *
 * Content-Type is left unset deliberately: the browser has to write the
 * multipart boundary into it, and naming the type here would clobber that.
 */
export async function uploadCameraSnapshot(cameraId, file, { cause, verdict = 'ng' } = {}) {
  const body = new FormData()
  body.append('file', file)
  const { data } = await apiClient.post(`/cameras/${cameraId}/snapshots`, body, {
    params: { cause: cause || undefined, verdict },
  })
  return data
}

export async function deleteCameraSnapshot(cameraId, snapshotId) {
  await apiClient.delete(`/cameras/${cameraId}/snapshots/${snapshotId}`)
}
