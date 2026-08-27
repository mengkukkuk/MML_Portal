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
  return data // [{ id, code, name, station_code, station_label, location, stream_url, notes, binding, enabled, updated_at }]
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

/** Snapshot metadata only — no bytes. Pass `cause` to filter the strip. */
export async function fetchCameraSnapshots(cameraId, { limit = 30, cause } = {}) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/snapshots`, {
    params: { limit, cause: cause || undefined },
  })
  return data // [{ id, camera_id, captured_at, cause, verdict, mime, size_bytes }]
}

/** NG-frame counts by cause, most frequent first — drives the rail's bars. */
export async function fetchCameraCauseCounts(cameraId) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/causes`)
  return data // [{ cause, n }]
}

/**
 * Plant-wide inspected/NG totals over the header's selected sources.
 * `total`/`ng` are null — not zero — when the camera has no plant binding yet.
 */
export async function fetchCameraSummary(cameraId) {
  const { data } = await apiClient.get(`/cameras/${cameraId}/summary`)
  return data // { total, ng, sources }
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
