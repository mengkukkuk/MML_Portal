import { apiClient } from './client'

/**
 * Custom-symbol API — the images an admin uploads, and the symbol library built
 * from them. Mirrors the asset and symbol halves of the /api/mimic router in
 * scada-mml-backend/mimic.py.
 *
 * Two levels, on purpose. An *asset* is a picture. A *symbol* is what an admin
 * authored from that picture: its size, its ports and the dynamics that make it
 * move. Layout nodes reference the symbol, never the asset, so re-authoring one
 * entry updates every drawing that uses it.
 */

/** Every uploaded image, without its bytes. `used_by` counts library symbols. */
export async function fetchMimicAssets() {
  const { data } = await apiClient.get('/mimic/assets')
  return data // [{ id, name, mime, size_bytes, used_by, created_at }]
}

/**
 * Upload one image. Admin only.
 *
 * Uploading a file the server already holds returns the existing row rather than
 * a duplicate — the server matches on a content hash, so dragging the same icon
 * in twice is a no-op instead of a second near-identical library entry.
 *
 * Content-Type is left unset deliberately: the browser has to write the
 * multipart boundary into it, and naming the type here would clobber that.
 */
export async function uploadMimicAsset(file) {
  const body = new FormData()
  body.append('file', file)
  const { data } = await apiClient.post('/mimic/assets', body)
  return data // { id, name, mime, size_bytes, created_at }
}

/** Refused with 400 while a library symbol still draws with this image. */
export async function deleteMimicAsset(id) {
  await apiClient.delete(`/mimic/assets/${id}`)
}

export async function fetchMimicSymbols() {
  const { data } = await apiClient.get('/mimic/symbols')
  return data // [{ id, name, asset_id, w, h, ports, dynamics, binding, bubble }]
}

export async function createMimicSymbol(body) {
  const { data } = await apiClient.post('/mimic/symbols', body)
  return data
}

/** Replaces the definition whole — there is no PATCH, same as a layout. */
export async function updateMimicSymbol(id, body) {
  const { data } = await apiClient.put(`/mimic/symbols/${id}`, body)
  return data
}

export async function deleteMimicSymbol(id) {
  await apiClient.delete(`/mimic/symbols/${id}`)
}
