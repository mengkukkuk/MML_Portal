import { useEffect, useState } from 'react'
import { apiClient } from '@/api/client'

/**
 * useAssetUrl — a drawable URL for one uploaded symbol image.
 *
 * Why this exists at all: the access token is a Bearer header attached by the
 * Axios interceptor (src/api/client.js), and the refresh cookie is scoped to
 * `/api/auth`. A browser-issued request for `<image href="/api/mimic/assets/7">`
 * carries neither, so it would come back 401 and the symbol would draw empty.
 * So the bytes are fetched through the API client — which does attach the token,
 * and does refresh it — and handed to the renderer as a blob URL.
 *
 * The alternative was to make the asset endpoint public. That was rejected: it
 * would put an unauthenticated reader for uploaded files on the API, and the
 * uploads include SVG.
 */

/**
 * assetId -> { url } once resolved, or { promise } while in flight.
 *
 * Module-level, and deliberately never revoked. Assets are immutable (a row's
 * bytes are never rewritten — an edit uploads a new asset and repoints the
 * symbol), there are a handful of them, and they are re-requested constantly:
 * every drag re-renders every symbol, and a per-component lifetime would mean
 * revoking a URL another node is still drawing with. A page load is the scope.
 */
const cache = new Map()

async function load(assetId) {
  const { data } = await apiClient.get(`/mimic/assets/${assetId}`, {
    responseType: 'blob',
  })
  const url = URL.createObjectURL(data)
  cache.set(assetId, { url })
  return url
}

/**
 * Start (or join) the fetch for one asset. Concurrent callers share one request
 * — a drawing with eight copies of the same custom symbol should not open with
 * eight identical downloads in flight.
 */
function resolve(assetId) {
  const hit = cache.get(assetId)
  if (hit) return hit
  const entry = {
    promise: load(assetId).catch((err) => {
      // Drop the failed entry so a later render can retry. Keeping it would
      // cache the failure for the rest of the session.
      cache.delete(assetId)
      throw err
    }),
  }
  cache.set(assetId, entry)
  return entry
}

/**
 * The blob URL for `assetId`, or null until it arrives (and if it never does).
 *
 * Returns null rather than throwing: one unreachable image should leave one
 * symbol undrawn, not take the drawing down. CustomSymbol renders its outline
 * either way, so a missing picture reads as a symbol whose image has not loaded
 * rather than as a hole in the plant.
 */
export default function useAssetUrl(assetId) {
  const [url, setUrl] = useState(() => (assetId ? cache.get(assetId)?.url ?? null : null))

  useEffect(() => {
    if (!assetId) { setUrl(null); return undefined }

    const entry = resolve(assetId)
    if (entry.url) { setUrl(entry.url); return undefined }

    // The node may be dragged off the canvas, or the drawing switched, before
    // the bytes land.
    let alive = true
    entry.promise.then(
      (u) => { if (alive) setUrl(u) },
      () => { if (alive) setUrl(null) },
    )
    return () => { alive = false }
  }, [assetId])

  return url
}
