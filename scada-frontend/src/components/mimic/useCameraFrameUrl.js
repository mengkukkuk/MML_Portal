import { useEffect, useState } from 'react'
import { apiClient } from '@/api/client'

/**
 * useCameraFrameUrl — a drawable URL for one folder-backed inspection frame.
 *
 * Fetched through Axios rather than handed to `<img src>` because the access
 * token rides an interceptor rather than a cookie, so a browser-issued request
 * against the API comes back 401. Hence the bounded LRU of object URLs below,
 * revoked on eviction.
 *
 * The cache key is the interesting part. A frame is addressed by its *position*
 * in a folder the vision system keeps writing to — index 0 means "the newest
 * file", which is a different image tomorrow. Keying on `code/slot/index` alone
 * would pin the first frame an operator ever saw for the life of the page, no
 * matter what the HTTP cache headers said, because this cache never
 * revalidates.
 *
 * So `mtimeNs` is part of the key. The listing endpoint returns it per frame, a
 * replaced file changes it, and the new key simply misses the cache.
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

function keyFor(code, slot, index, mtimeNs) {
  return `${code}/${slot}/${index}/${mtimeNs}`
}

async function load(code, slot, index, key) {
  const { data } = await apiClient.get(
    `/cameras/${encodeURIComponent(code)}/defects/${slot}/frames/${index}/image`,
    { responseType: 'blob' },
  )
  const url = URL.createObjectURL(data)
  // Re-insert so this key becomes the most-recently-used for eviction order.
  cache.delete(key)
  cache.set(key, { url })
  evictIfNeeded()
  return url
}

function resolve(code, slot, index, mtimeNs) {
  const key = keyFor(code, slot, index, mtimeNs)
  const hit = cache.get(key)
  if (hit) {
    // Touch it: a still-visible frame should outlive a scrolled-past one.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const entry = {
    promise: load(code, slot, index, key).catch((err) => {
      cache.delete(key)
      throw err
    }),
  }
  cache.set(key, entry)
  return entry
}

/** The blob URL for one frame, or null until it arrives (and if it never does). */
export default function useCameraFrameUrl(code, slot, index, mtimeNs) {
  const ready = !!code && slot != null && index != null
  const [url, setUrl] = useState(
    () => (ready ? cache.get(keyFor(code, slot, index, mtimeNs))?.url ?? null : null),
  )

  useEffect(() => {
    if (!ready) { setUrl(null); return undefined }

    const entry = resolve(code, slot, index, mtimeNs)
    if (entry.url) { setUrl(entry.url); return undefined }

    let alive = true
    entry.promise.then(
      (u) => { if (alive) setUrl(u) },
      () => { if (alive) setUrl(null) },
    )
    return () => { alive = false }
  }, [ready, code, slot, index, mtimeNs])

  return url
}
