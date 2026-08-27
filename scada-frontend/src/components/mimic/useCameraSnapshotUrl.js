import { useEffect, useState } from 'react'
import { apiClient } from '@/api/client'

/**
 * useCameraSnapshotUrl — a drawable URL for one stored camera frame.
 *
 * Same reason as useAssetUrl.js: the access token rides an Axios interceptor,
 * not a cookie, so a browser-issued `<img src="/api/cameras/…/image">` would
 * come back 401. The bytes are fetched through the API client and handed to
 * the strip as a blob URL.
 *
 * Unlike useAssetUrl's cache, this one is bounded and revokes on eviction.
 * A symbol library has "a handful" of images reused on every drag; a camera's
 * NG strip is a rolling window of *stored evidence* — 30 frames per camera,
 * times however many cameras get clicked in a session — so a never-revoked
 * Map here would just leak blob URLs for the length of the page's life.
 */

const MAX_ENTRIES = 60
const cache = new Map() // key -> { url } | { promise }

function evictIfNeeded() {
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    const entry = cache.get(oldestKey)
    if (entry?.url) URL.revokeObjectURL(entry.url)
    cache.delete(oldestKey)
  }
}

function keyFor(cameraId, snapshotId) {
  return `${cameraId}/${snapshotId}`
}

async function load(cameraId, snapshotId, key) {
  const { data } = await apiClient.get(
    `/cameras/${cameraId}/snapshots/${snapshotId}/image`,
    { responseType: 'blob' },
  )
  const url = URL.createObjectURL(data)
  // Re-insert so this key becomes the most-recently-used for eviction order.
  cache.delete(key)
  cache.set(key, { url })
  evictIfNeeded()
  return url
}

function resolve(cameraId, snapshotId) {
  const key = keyFor(cameraId, snapshotId)
  const hit = cache.get(key)
  if (hit) {
    // Touch it: move to the end so a still-visible frame outlives a scrolled-past one.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const entry = {
    promise: load(cameraId, snapshotId, key).catch((err) => {
      cache.delete(key)
      throw err
    }),
  }
  cache.set(key, entry)
  return entry
}

/** The blob URL for one snapshot, or null until it arrives (and if it never does). */
export default function useCameraSnapshotUrl(cameraId, snapshotId) {
  const [url, setUrl] = useState(() =>
    cameraId && snapshotId ? cache.get(keyFor(cameraId, snapshotId))?.url ?? null : null,
  )

  useEffect(() => {
    if (!cameraId || !snapshotId) { setUrl(null); return undefined }

    const entry = resolve(cameraId, snapshotId)
    if (entry.url) { setUrl(entry.url); return undefined }

    let alive = true
    entry.promise.then(
      (u) => { if (alive) setUrl(u) },
      () => { if (alive) setUrl(null) },
    )
    return () => { alive = false }
  }, [cameraId, snapshotId])

  return url
}
