/**
 * latestBatcher — coalesces per-binding "latest value" reads into one request.
 *
 * A Live tile reads one value per series and a Monitor drawing one per bound
 * symbol, every tick. Sent one by one that was N requests per tick, and the
 * browser only runs ~6 at a time per host, so a large drawing queued behind
 * itself (and behind the camera strip). Callers still ask for one binding at a
 * time; reads issued within `windowMs` of each other leave as a single
 * POST /schema/latest/batch, and each caller gets back exactly what the
 * single-binding GET would have given it.
 *
 * Errors keep the axios shape (`err.response.status`, `err.response.data.detail`)
 * so `sourcesFromError` and `apiErrorMessage` read a batched 400/404 the same way
 * they read a standalone one. A failure of the batch request itself rejects every
 * member with that same error.
 *
 * Pure: `post(items) -> Promise<results[]>` is injected, so this module has no
 * dependency on the API client and runs under `node --test`.
 */

export const BATCH_WINDOW_MS = 10
export const MAX_BATCH = 100

/** The rejection a standalone GET would have produced for this item. */
function itemError(result) {
  const detail = result.detail ?? null
  const message = typeof detail?.error === 'string' ? detail.error : `HTTP ${result.status}`
  const err = new Error(message)
  err.response = { status: result.status, data: { detail } }
  return err
}

export function createLatestBatcher(post, { windowMs = BATCH_WINDOW_MS, maxBatch = MAX_BATCH } = {}) {
  let queue = []
  let timer = null

  function settle(members, results) {
    members.forEach((m, i) => {
      const r = results?.[i]
      if (!r) m.reject(new Error('Batch response is missing an item'))
      else if (r.status === 200) m.resolve({ readings: r.readings || [], sources: r.sources || [] })
      else m.reject(itemError(r))
    })
  }

  function flush() {
    timer = null
    const pending = queue
    queue = []
    for (let i = 0; i < pending.length; i += maxBatch) {
      const members = pending.slice(i, i + maxBatch)
      post(members.map((m) => m.item)).then(
        (results) => settle(members, results),
        (err) => members.forEach((m) => m.reject(err)),
      )
    }
  }

  return function enqueue(item) {
    return new Promise((resolve, reject) => {
      queue.push({ item, resolve, reject })
      if (timer == null) timer = setTimeout(flush, windowMs)
    })
  }
}
