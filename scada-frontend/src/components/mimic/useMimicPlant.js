import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, keepPreviousData } from '@tanstack/react-query'
import { fetchSchemaLatest, fetchSchemaSeries } from '@/api/schema'
import { applyExpr, compileExpr } from '@/utils/mathExpr'
import { deriveTag, EVENT_LOG_SIZE } from './deriveTag'

/**
 * useMimicPlant — the real /monitor poller.
 *
 * Emits the same snapshot as the simulator (`{ tags, history, events, ts,
 * running }`) but keyed by **node id** rather than loop id, because two symbols
 * may legitimately watch the same loop and each needs its own reading, pulse
 * and event trail.
 *
 * ## One query per backend, not one per symbol
 *
 * The page needs a *coherent* snapshot: plant status is reduced across every
 * tag, and the rail filters one shared event list. Independent per-symbol
 * queries can't produce either without a coordinating layer on top.
 *
 * But a single query for the whole plant would be worse. `_table_source_conn`
 * opens a fresh libpq handshake with `connect_timeout=5`, and `allSettled`
 * settles with the slowest call — so one unreachable historian would add ~5s to
 * every tick, app-database symbols included. Bucketing by `datasource_id` keeps
 * coherence where it matters and stops a dead host stalling the boiler. That is
 * the honest shape for a page designed to span backends.
 *
 * `useQueries` (not `useQuery` in a loop) because the number of backends is a
 * property of the drawing, not of the code.
 */

/** Sparkline window. A view preference, so it lives here, not in the doc. */
export const HISTORY_MINUTES = 30

/** Roughly the simulator's 120-point history at a 5s cadence, with headroom. */
const MAX_POINTS = 400

const EMPTY_SNAPSHOT = {
  tags: {}, history: {}, events: [], ts: 0, running: false, error: '',
}

// Compiled transforms are keyed by source text: the same expression appears on
// many symbols, and recompiling per poll would parse it once per tag per tick.
const exprCache = new Map()
function exprFor(src) {
  const key = src || ''
  if (!exprCache.has(key)) exprCache.set(key, compileExpr(key).fn ?? null)
  return exprCache.get(key)
}

/** Never blank a symbol: an all-aged-out window keeps its most recent point. */
function trimWindow(arr, minutes) {
  const cutoff = Date.now() - minutes * 60_000
  const kept = arr.filter(([t]) => t >= cutoff)
  const out = kept.length ? kept : arr.slice(-1)
  return out.length > MAX_POINTS ? out.slice(out.length - MAX_POINTS) : out
}

/** Signal fields of one binding, as the schema API wants them. */
function argsOf(b) {
  return {
    table: b.table,
    valueCol: b.value_col,
    tsCol: b.ts_col || undefined,
    filterCol: b.filter_col || undefined,
    filterVal: b.filter_val ?? undefined,
    datasourceId: b.datasource_id ?? undefined,
  }
}

/**
 * The parts of a binding that invalidate accumulated history when they change.
 * Presentation (unit, decimals, limits, range) is deliberately absent: retuning
 * an alarm limit must not throw away the trend behind it.
 */
function signatureOf(items) {
  return items
    .map(({ nodeId, b }) => [
      nodeId, b.table, b.value_col, b.ts_col, b.filter_col, b.filter_val, b.expr,
    ].join(''))
    .join('')
}

// --- seed: full window per binding, once per signature ----------------------
async function seedGroup(items, minutes) {
  const points = {}
  const latest = {}
  items.forEach(({ nodeId }) => { points[nodeId] = [] })

  const withTs = items.filter(({ b }) => b.ts_col)
  if (withTs.length) {
    const results = await Promise.allSettled(
      withTs.map(({ b }) => fetchSchemaSeries({ ...argsOf(b), minutes })),
    )
    results.forEach((res, i) => {
      const { nodeId, b } = withTs[i]
      if (res.status !== 'fulfilled') return
      const fn = exprFor(b.expr)
      const arr = res.value.points.map((p) => [new Date(p.ts).getTime(), applyExpr(fn, p.value)])
      points[nodeId] = arr
      if (arr.length) {
        const last = res.value.points[res.value.points.length - 1]
        latest[nodeId] = {
          value: applyExpr(fn, last.value), ts: new Date(last.ts).getTime(), okAt: Date.now(),
        }
      }
    })
  }

  // Stale-source fallback, same rule as usePanelPolling: a binding with no rows
  // in the window shows its last known reading rather than nothing. This also
  // covers every binding with no timestamp column, which has no window at all.
  const empty = items.filter(({ nodeId }) => !points[nodeId].length)
  if (empty.length) {
    const results = await Promise.allSettled(
      empty.map(({ b }) => fetchSchemaLatest(argsOf(b))),
    )
    results.forEach((res, i) => {
      const { nodeId, b } = empty[i]
      if (res.status !== 'fulfilled' || res.value.value == null) return
      const value = applyExpr(exprFor(b.expr), res.value.value)
      const t = res.value.ts ? new Date(res.value.ts).getTime() : Date.now()
      points[nodeId] = [[t, value]]
      latest[nodeId] = { value, ts: t, okAt: Date.now() }
    })
  }

  return { points, latest }
}

// --- poll: one latest row per binding, appended --------------------------
async function pollGroup(items, prev, minutes) {
  // allSettled, never all: one broken binding must not blank the drawing.
  const results = await Promise.allSettled(
    items.map(({ b }) => fetchSchemaLatest(argsOf(b))),
  )
  const sampleT = Date.now()
  const points = { ...prev.points }
  const latest = { ...prev.latest }

  results.forEach((res, i) => {
    const { nodeId, b } = items[i]
    if (res.status !== 'fulfilled') {
      // Leave the previous entry in place; deriveTag ages it into `stale`.
      console.error('[mimic] latest fetch failed:', nodeId, res.reason)
      return
    }
    if (res.value.value == null) return
    const value = applyExpr(exprFor(b.expr), res.value.value)
    // A history table carries a row timestamp, so only append when it advances.
    // A current-state table has none — sample at wall-clock so a steady value
    // still moves the trend forward instead of flat-lining at one point.
    const t = b.ts_col && res.value.ts ? new Date(res.value.ts).getTime() : sampleT
    const arr = points[nodeId] || []
    const lastT = arr.length ? arr[arr.length - 1][0] : -1
    if (t > lastT) points[nodeId] = trimWindow([...arr, [t, value]], minutes)
    // `okAt` is the wall-clock of the last *successful* fetch, distinct from
    // `ts` (the row's own timestamp). A failed poll deliberately leaves the
    // previous reading in place so the drawing keeps its last known numbers —
    // which means the value alone can never tell you the source went away.
    latest[nodeId] = { value, ts: t, okAt: sampleT }
  })

  return { points, latest }
}

export default function useMimicPlant({
  nodes = [],
  pollSeconds = 5,
  historyMinutes = HISTORY_MINUTES,
  refreshSignal = 0,
  enabled = true,
}) {
  const bound = useMemo(
    () => nodes.filter((n) => n.binding?.table && n.binding?.value_col),
    [nodes],
  )

  const groups = useMemo(() => {
    const byBackend = new Map()
    bound.forEach((n) => {
      const key = n.binding.datasource_id ?? null
      if (!byBackend.has(key)) byBackend.set(key, [])
      byBackend.get(key).push({ nodeId: n.id, b: n.binding })
    })
    return [...byBackend.entries()].map(([dsId, items]) => ({ dsId, items }))
  }, [bound])

  // Accumulators live in a ref, not React state: they are what the *next* poll
  // appends onto, and re-rendering on every append would double the work.
  const accumRef = useRef(new Map())

  const queryDefs = useMemo(() => groups.map((g) => {
    const queryKey = ['mimic-plant', g.dsId, signatureOf(g.items), historyMinutes, refreshSignal]
    const hashed = JSON.stringify(queryKey)
    return {
      queryKey,
      enabled: enabled && g.items.length > 0,
      queryFn: async () => {
        const prev = accumRef.current.get(hashed)
        const result = prev
          ? await pollGroup(g.items, prev, historyMinutes)
          : await seedGroup(g.items, historyMinutes)
        accumRef.current.set(hashed, result)
        return result
      },
      // Cadence drives the interval only — never the key. Fold it in and every
      // cadence change would discard the accumulated history and re-seed.
      refetchInterval: pollSeconds * 1000,
      // A SCADA wall display must not freeze in a background tab.
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
    }
  }), [groups, historyMinutes, refreshSignal, enabled, pollSeconds])

  const results = useQueries({ queries: queryDefs })

  // Prune accumulators belonging to superseded signatures, or the map grows for
  // the page's lifetime as an admin retunes bindings.
  useEffect(() => {
    const live = new Set(queryDefs.map((q) => JSON.stringify(q.queryKey)))
    accumRef.current.forEach((_, key) => {
      if (!live.has(key)) accumRef.current.delete(key)
    })
  }, [queryDefs])

  // --- derivation ----------------------------------------------------------
  // Carried across ticks, so it cannot live in a memo: React may discard and
  // recompute one, which would replay every pulse and duplicate every event.
  const prevTagsRef = useRef({})
  const pulsesRef = useRef({})
  const eventsRef = useRef([])
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)

  // `results` is a fresh array every render; a stamp of when each query last
  // produced data is what actually says "there is something new to derive".
  const stamp = results.map((r) => `${r.dataUpdatedAt}:${r.errorUpdatedAt}`).join(',')
  const resultsRef = useRef(results)
  resultsRef.current = results
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const boundRef = useRef(bound)
  boundRef.current = bound

  useEffect(() => {
    if (!enabled) {
      setSnapshot(EMPTY_SNAPSHOT)
      prevTagsRef.current = {}
      eventsRef.current = []
      return
    }
    const now = Date.now()
    const readings = {}
    const history = {}
    let anyData = false

    resultsRef.current.forEach((res, gi) => {
      const group = groupsRef.current[gi]
      if (!group) return
      if (!res.data) return
      anyData = true
      group.items.forEach(({ nodeId }) => {
        readings[nodeId] = res.data.latest[nodeId] ?? null
        history[nodeId] = res.data.points[nodeId] ?? []
      })
    })

    const tags = {}
    const fresh = []
    let unreadable = 0
    boundRef.current.forEach((node) => {
      const reading = readings[node.id] ?? null
      // "We can't reach it" is a different fault from "what it holds is old",
      // and only the first is a connection problem — a historian that stopped
      // being written to three weeks ago answers every query perfectly. So
      // this counts fetch freshness (`okAt`), never the row's own timestamp.
      const okAt = reading?.okAt ?? 0
      if (now - okAt > pollSeconds * 1000 * 3) unreadable += 1
      const { entry, pulse, event } = deriveTag({
        node,
        reading,
        prev: prevTagsRef.current[node.id] ?? null,
        pulse: pulsesRef.current[node.id] ?? 0,
        now,
        pollSeconds,
      })
      tags[node.id] = entry
      pulsesRef.current[node.id] = pulse
      if (event) fresh.push(event)
    })

    if (fresh.length) {
      eventsRef.current = fresh.reverse().concat(eventsRef.current).slice(0, EVENT_LOG_SIZE)
    }
    prevTagsRef.current = tags

    setSnapshot({
      tags,
      history,
      events: eventsRef.current,
      ts: now,
      running: anyData,
      // The banner means "nothing is reaching us at all", not "a loop is down"
      // and not "the data is old".
      //
      // It cannot key off query errors: pollGroup uses allSettled and never
      // rejects, so `isError` stays false however many bindings fail — and with
      // keepPreviousData a page whose backends had all died would still report
      // data and show no warning. Counting bindings that returned nothing is
      // the honest signal: it stays silent for the single dead binding that
      // plan step 8 requires the rest of the drawing to survive, and silent
      // for a reachable-but-stale source, which the symbols already show.
      error: bound.length && unreadable === bound.length
        ? 'Connection error — retrying…'
        : '',
    })
  }, [stamp, enabled, pollSeconds, bound.length])

  return snapshot
}
