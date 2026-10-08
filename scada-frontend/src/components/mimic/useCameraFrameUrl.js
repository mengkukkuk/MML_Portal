import { useEffect, useState } from 'react'
import { apiClient } from '@/api/client'
import { cameraFramePath } from '@/api/cameras'

/**
 * useCameraFrameUrl — a drawable URL for one folder-backed inspection frame.
 *
 * Blob URLs because the access token rides an Axios interceptor rather than a
 * cookie, so a browser-issued `<img src>` against the API comes back 401.
 *
 * Three properties matter here, each added because the plain version failed on a
 * slow link to a deployed server:
 *
 * **Keyed by the frame's durable id, not its position.** A frame is a file in a
 * folder the vision system keeps writing to; "index 0" is a different file a
 * minute later and every older frame shifts down one. A position-keyed cache
 * therefore missed on *all thirty* tiles each time a capture arrived and
 * re-downloaded the lot. The id embeds the file's mtime and never changes for a
 * given capture, so an arriving frame costs exactly one new fetch.
 *
 * **Thumbnails for the strip, originals only on demand.** `thumb` asks for a
 * small server-rendered JPEG; the lightbox asks for the original. Both are
 * cached, under different keys, with separate bounds because an original is
 * ~50x the size.
 *
 * **Polite about the connection.** Browsers allow ~6 concurrent HTTP/1.1
 * connections per host, shared with the polling queries. So loads go through a
 * small gate (never more than MAX_IN_FLIGHT), a load nobody wants any more is
 * aborted instead of left to occupy a slot, and aborts are deferred a beat so a
 * remount (StrictMode, a re-render that swaps keys) does not throw away a
 * request that is about to be wanted again.
 */

const MAX_IN_FLIGHT = 4
const MAX_THUMBS = 200
const MAX_FULL = 8
// An original can take several seconds on a slow link; the global 10 s axios
// timeout counts time spent queued in the browser, which is how most of these
// requests used to die before sending a byte.
const IMAGE_TIMEOUT_MS = 30_000
const ABORT_GRACE_MS = 300

const cache = new Map() // key -> entry; insertion order doubles as LRU order
const queue = [] // entries waiting for a slot
let inFlight = 0

function keyFor(cameraCode, slot, frameId, thumb) {
  return `${cameraCode}/${slot}/${frameId}/${thumb ? 't' : 'f'}`
}

function evict(thumb, max) {
  let count = 0
  cache.forEach((e) => { if (e.thumb === thumb && e.url) count += 1 })
  if (count <= max) return
  for (const [key, e] of cache) {
    if (count <= max) break
    // Never revoke a URL an <img> on screen is still using.
    if (e.thumb === thumb && e.url && e.refs === 0) {
      URL.revokeObjectURL(e.url)
      cache.delete(key)
      count -= 1
    }
  }
}

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const entry = queue.shift()
    if (entry.status !== 'queued') continue // aborted while waiting
    start(entry)
  }
}

function start(entry) {
  entry.status = 'loading'
  inFlight += 1
  apiClient
    .get(entry.path, {
      responseType: 'blob',
      signal: entry.controller.signal,
      timeout: IMAGE_TIMEOUT_MS,
      _noRetry: true,
    })
    .then(({ data }) => {
      entry.url = URL.createObjectURL(data)
      entry.status = 'done'
      // Re-insert so this key is the most recently used for eviction order.
      cache.delete(entry.key)
      cache.set(entry.key, entry)
      evict(entry.thumb, entry.thumb ? MAX_THUMBS : MAX_FULL)
      entry.resolve(entry.url)
    })
    .catch((err) => {
      entry.status = 'error'
      // Forget it so the next mount tries again rather than caching a failure.
      if (cache.get(entry.key) === entry) cache.delete(entry.key)
      entry.reject(err)
    })
    .finally(() => {
      inFlight -= 1
      pump()
    })
}

function acquire(cameraCode, slot, frameId, thumb, priority) {
  const key = keyFor(cameraCode, slot, frameId, thumb)
  const hit = cache.get(key)
  if (hit) {
    hit.refs += 1
    clearTimeout(hit.abortTimer)
    // Touch it: a still-visible frame should outlive a scrolled-past one.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const entry = {
    key, thumb, refs: 1, url: null, status: 'queued',
    path: cameraFramePath(cameraCode, slot, frameId, { thumb }),
    controller: new AbortController(),
    abortTimer: null,
  }
  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve
    entry.reject = reject
  })
  // Nobody may be listening by the time it fails (the tile scrolled away);
  // that is expected, not an unhandled rejection.
  entry.promise.catch(() => {})

  cache.set(key, entry)
  if (priority) queue.unshift(entry)
  else queue.push(entry)
  pump()
  return entry
}

function release(entry) {
  entry.refs -= 1
  if (entry.refs > 0 || entry.status === 'done') return
  // Wanted by no one and not finished: give a remount a moment to claim it,
  // then stop spending a connection slot on it.
  entry.abortTimer = setTimeout(() => {
    if (entry.refs > 0 || entry.status === 'done') return
    if (cache.get(entry.key) === entry) cache.delete(entry.key)
    if (entry.status === 'queued') entry.status = 'aborted'
    entry.controller.abort()
  }, ABORT_GRACE_MS)
}

/**
 * The blob URL for one frame, or null until it arrives (and if it never does).
 *
 * `frameId` is the `id` from the frames listing. `thumb` selects the preview
 * rather than the original. `priority` jumps the queue — for the one image the
 * operator just asked to see. `enabled` lets a caller defer the fetch (tiles
 * outside the visible window) without conditionally calling the hook.
 */
export default function useCameraFrameUrl(
  cameraCode,
  slot,
  frameId,
  { thumb = false, priority = false, enabled = true } = {},
) {
  const ready = enabled && !!cameraCode && slot != null && !!frameId
  const cacheKey = ready ? keyFor(cameraCode, slot, frameId, thumb) : null

  const [prevKey, setPrevKey] = useState(cacheKey)
  const [url, setUrl] = useState(() => (ready ? cache.get(cacheKey)?.url ?? null : null))

  // Read the cache synchronously as soon as the key changes rather than waiting
  // for the effect below (which runs post-paint). Without this, a tile that
  // moves to an already-cached key briefly renders the *previous* url.
  if (cacheKey !== prevKey) {
    setPrevKey(cacheKey)
    setUrl(ready ? cache.get(cacheKey)?.url ?? null : null)
  }

  useEffect(() => {
    if (!ready) { setUrl(null); return undefined }

    const entry = acquire(cameraCode, slot, frameId, thumb, priority)
    let alive = true
    if (entry.url) {
      setUrl(entry.url)
    } else {
      entry.promise.then(
        (u) => { if (alive) setUrl(u) },
        () => { if (alive) setUrl(null) },
      )
    }
    return () => {
      alive = false
      release(entry)
    }
    // `priority` only matters at acquire time; changing it must not re-fetch.
  }, [ready, cameraCode, slot, frameId, thumb])

  return url
}
