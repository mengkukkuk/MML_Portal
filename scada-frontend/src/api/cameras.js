import { apiClient } from './client'

/**
 * Inspection-frame API — the *image* half of the /monitor camera rail.
 * Mirrors the /api/cameras router in scada-mml-backend/cameras.py.
 *
 * Camera identity and defect counters are no longer here. They are plant data
 * owned by the vision system, reached through a mimic's `doc.cameraDefect`
 * binding — see fetchMimicCameras/fetchMimicCameraDefects in ./mimic.js. What
 * is left is what needs no binding at all: files the vision system wrote into a
 * folder, read off disk by the backend.
 *
 * Addressed by camera **code**, not a row id. A code is what the vision system
 * writes into its folder names and what is printed on the physical station; a
 * row id is a per-database serial that collides across plants the moment these
 * tables live in more than one.
 *
 * Read-only. This application never writes under the image root.
 */

/**
 * Frames stored on disk for one defect slot, newest first.
 *
 * Empty — never an error — on an install with no image share mounted, on an
 * unknown code, and on a slot the line has never used. All three are the same
 * thing to an operator: nothing to look at.
 */
export async function fetchCameraDefectFrames(code, slot, { limit = 30 } = {}) {
  const { data } = await apiClient.get(
    `/cameras/${encodeURIComponent(code)}/defects/${slot}/frames`,
    { params: { limit } },
  )
  return data // [{ index, captured_at, size_bytes, mtime_ns }]
}
