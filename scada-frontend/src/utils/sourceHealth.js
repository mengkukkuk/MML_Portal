/**
 * Shared merge rules for the `{datasource_id, datasource_name, ok, error}`
 * reports that every fanned-out response carries — used anywhere a page or
 * panel has to combine several of them into one verdict per source.
 */

/**
 * Merge per-source reports from several requests that all fanned out over the
 * *same* selection in the *same* round (e.g. one panel's several configured
 * tags, each fetched concurrently).
 *
 * "Down" always wins over "up": these requests raced each other against the
 * same real-time state, so if any of them caught a source mid-failure, that
 * failure is real and a sibling request that happened to land in the lucky
 * gap between retries must not be allowed to hide it.
 *
 * Returns null when nothing was fanned out yet, so callers can tell "no data"
 * apart from "confirmed empty".
 */
export function mergeSources(lists) {
  const byId = new Map()
  for (const list of lists) {
    if (!list) continue
    for (const s of list) {
      const id = s.datasource_id ?? null
      const prev = byId.get(id)
      byId.set(id, prev ? {
        ...prev,
        ok: prev.ok && s.ok,
        error: prev.error || s.error,
      } : { ...s })
    }
  }
  return byId.size ? Array.from(byId.values()) : null
}

/**
 * Fold a fresh `sources` report into a `Map<datasourceId, report>` that
 * tracks the single most recent observation of each source, in place.
 *
 * Unlike `mergeSources`, this is for combining reports that arrive at
 * *different times* from independent pollers (e.g. every panel on a page,
 * each on its own interval) — so recency wins, not "down". Overwriting
 * unconditionally is what lets a source's status catch up the moment any
 * poller — fast or slow — observes a change; the alternative (merging by
 * "down wins" across pollers, or rebuilding from every poller's last-known
 * snapshot in map-insertion order) lets one panel's stale, pre-outage "ok"
 * mask another panel's current "down" indefinitely, which is the exact
 * failure this function exists to avoid.
 *
 * Returns true if anything actually changed, so callers can skip a
 * re-render when a poll simply reconfirmed the status quo.
 */
export function applySourceUpdate(map, sources) {
  if (!sources) return false
  let changed = false
  for (const s of sources) {
    const id = s.datasource_id ?? null
    const prev = map.get(id)
    if (!prev || prev.ok !== s.ok || prev.error !== s.error || prev.datasource_name !== s.datasource_name) {
      changed = true
    }
    map.set(id, s)
  }
  return changed
}

/**
 * Recover the per-source report from a rejected fan-out request.
 *
 * When every selected source fails, the backend collapses what would
 * otherwise be N identical "table not found" warnings into a single error
 * response — but it still attaches the full per-source `sources` list to that
 * error's body (see schema.py's `_raise_if_all_failed`, tags.py's `/latest`),
 * specifically so a total outage doesn't look any different from "no report
 * was ever made". Without unpacking it here, `Promise.allSettled` callers
 * would see only a rejection and lose the one signal that tells the operator
 * which source is actually down.
 */
export function sourcesFromError(err) {
  return err?.response?.data?.detail?.sources || null
}

// Shared so every "connection error" tile — Live panels, Monitor symbols —
// reads the same way and can be recognised the same way (see below).
const CONNECTION_ERROR_PREFIX = 'Connection'

/**
 * Build the tile-facing "still trying" message, naming which selected
 * source(s) are actually down instead of leaving the operator to guess which
 * of several selected plants dropped out.
 *
 * Falls back to the old unnamed message when no per-source report is
 * available at all — a request that failed before it ever reached the
 * fan-out layer (a network error, a dev-server restart) carries no `sources`
 * to name.
 */
export function connectionErrorMessage(sources) {
  const names = (sources || [])
    .filter((s) => !s.ok)
    .map((s) => s.datasource_name || (s.datasource_id != null ? `source ${s.datasource_id}` : null))
    .filter(Boolean)
  return names.length
    ? `${CONNECTION_ERROR_PREFIX} to ${names.join(', ')} error — retrying…`
    : `${CONNECTION_ERROR_PREFIX} error — retrying…`
}

/**
 * Recognise a `connectionErrorMessage()` result regardless of which source(s)
 * it names, so callers that need to branch on "is this a connection fault"
 * (e.g. deciding whether to schedule a quick retry) don't have to match the
 * message verbatim — which broke the moment the message started carrying a
 * source name.
 */
export function isConnectionError(message) {
  return typeof message === 'string' && message.startsWith(CONNECTION_ERROR_PREFIX)
}
