import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { fetchSchemaLatest, fetchSchemaSeries, fromPrimarySource } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { applyExpr, compileExpr } from '@/utils/mathExpr'
import { mergeSources, sourcesFromError, connectionErrorMessage } from '@/utils/sourceHealth'
import { deriveTag, EVENT_LOG_SIZE } from './deriveTag'

/**
 * How long every binding must go unanswered before the page calls the plant
 * unreachable. Three polls, but never less than three seconds: a sub-second
 * cadence issues its next request before the previous round trip has landed,
 * and a busy historian would otherwise be declared down on latency alone.
 */
function unreachableAfterMs(pollSeconds) {
  return Math.max(pollSeconds * 1000 * 3, 3000)
}

/**
 * useMimicPlant — the real /monitor poller.
 *
 * Emits the same snapshot as the simulator (`{ tags, history, events, ts,
 * running }`) but keyed by **node id** rather than loop id, because two symbols
 * may legitimately watch the same loop and each needs its own reading, pulse
 * and event trail.
 *
 * ## One query for the whole drawing
 *
 * The page needs a *coherent* snapshot: plant status is reduced across every
 * tag, and the rail filters one shared event list. Independent per-symbol
 * queries can't produce either without a coordinating layer on top.
 *
 * This used to be one query per `binding.datasource_id`, so that an unreachable
 * historian couldn't add its connect timeout to every other symbol's tick. That
 * bucketing no longer routes anywhere: every read now goes to the datasources
 * selected in the header, so all bindings share one destination and the backend
 * absorbs a dead host on its own fan-out workers.
 *
 * ## Symbols read the primary source only
 *
 * A symbol is one physical asset — a specific generator in a specific building
 * — so fanning it out across plants would draw several plants' numbers onto one
 * piece of equipment. Every reading is therefore taken from the first selected
 * source; selecting more sources enriches Live/Events/Alarms and leaves the
 * drawing alone.
 */

/** Sparkline window. A view preference, so it lives here, not in the doc. */
export const HISTORY_MINUTES = 30

/** Roughly the simulator's 120-point history at a 5s cadence, with headroom. */
const MAX_POINTS = 400

const EMPTY_SNAPSHOT = {
  tags: {}, history: {}, events: [], ts: 0, running: false, error: '', sources: [],
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
  const sourceLists = []
  items.forEach(({ nodeId }) => { points[nodeId] = [] })

  const withTs = items.filter(({ b }) => b.ts_col)
  if (withTs.length) {
    const results = await Promise.allSettled(
      withTs.map(({ b }) => fetchSchemaSeries({ ...argsOf(b), minutes })),
    )
    results.forEach((res, i) => {
      const { nodeId, b } = withTs[i]
      if (res.status !== 'fulfilled') {
        const errSources = sourcesFromError(res.reason)
        if (errSources) sourceLists.push(errSources)
        return
      }
      sourceLists.push(res.value.sources)
      const one = fromPrimarySource(res.value.series, res.value.sources)
      if (!one) return
      const fn = exprFor(b.expr)
      const arr = one.points.map((p) => [new Date(p.ts).getTime(), applyExpr(fn, p.value)])
      points[nodeId] = arr
      if (arr.length) {
        const last = one.points[one.points.length - 1]
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
      if (res.status !== 'fulfilled') {
        const errSources = sourcesFromError(res.reason)
        if (errSources) sourceLists.push(errSources)
        return
      }
      sourceLists.push(res.value.sources)
      const row = fromPrimarySource(res.value.readings, res.value.sources)
      if (row?.value == null) return
      const value = applyExpr(exprFor(b.expr), row.value)
      const t = row.ts ? new Date(row.ts).getTime() : Date.now()
      points[nodeId] = [[t, value]]
      latest[nodeId] = { value, ts: t, okAt: Date.now() }
    })
  }

  // Every binding fans out over the identical selection, so a source any one
  // of these concurrent requests caught mid-failure is really down — a
  // luckier sibling request's "ok" must not hide it.
  return { points, latest, sources: mergeSources(sourceLists) || [] }
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
  const sourceLists = []

  results.forEach((res, i) => {
    const { nodeId, b } = items[i]
    if (res.status !== 'fulfilled') {
      // Leave the previous entry in place; deriveTag ages it into `stale`.
      const errSources = sourcesFromError(res.reason)
      if (errSources) sourceLists.push(errSources)
      console.error('[mimic] latest fetch failed:', nodeId, res.reason)
      return
    }
    sourceLists.push(res.value.sources)
    const row = fromPrimarySource(res.value.readings, res.value.sources)
    if (row?.value == null) return
    const value = applyExpr(exprFor(b.expr), row.value)
    // A history table carries a row timestamp, so only append when it advances.
    // A current-state table has none — sample at wall-clock so a steady value
    // still moves the trend forward instead of flat-lining at one point.
    const t = b.ts_col && row.ts ? new Date(row.ts).getTime() : sampleT
    const arr = points[nodeId] || []
    const lastT = arr.length ? arr[arr.length - 1][0] : -1
    if (t > lastT) points[nodeId] = trimWindow([...arr, [t, value]], minutes)
    // `okAt` is the wall-clock of the last *successful* fetch, distinct from
    // `ts` (the row's own timestamp). A failed poll deliberately leaves the
    // previous reading in place so the drawing keeps its last known numbers —
    // which means the value alone can never tell you the source went away.
    latest[nodeId] = { value, ts: t, okAt: sampleT }
  })

  return { points, latest, sources: mergeSources(sourceLists) || prev.sources || [] }
}

export default function useMimicPlant({
  nodes = [],
  pollSeconds = 5,
  historyMinutes = HISTORY_MINUTES,
  refreshSignal = 0,
  enabled = true,
}) {
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const items = useMemo(
    () => nodes
      .filter((n) => n.binding?.table && n.binding?.value_col)
      .map((n) => ({ nodeId: n.id, b: n.binding })),
    [nodes],
  )
  const bound = useMemo(() => nodes.filter((n) => n.binding?.table && n.binding?.value_col), [nodes])

  // Accumulators live in a ref, not React state: they are what the *next* poll
  // appends onto, and re-rendering on every append would double the work.
  const accumRef = useRef(new Map())

  // The selection belongs in the key, not merely in an invalidation. A refetch
  // under an unchanged key takes the *poll* path and appends onto the previous
  // accumulator — switching plants without changing the key would splice the new
  // plant's readings onto the old plant's trend as one continuous line.
  const queryKey = useMemo(
    () => ['mimic-plant', selectionKey, signatureOf(items), historyMinutes, refreshSignal],
    [selectionKey, items, historyMinutes, refreshSignal],
  )
  const hashed = useMemo(() => JSON.stringify(queryKey), [queryKey])

  const query = useQuery({
    queryKey,
    enabled: enabled && items.length > 0,
    queryFn: async () => {
      const prev = accumRef.current.get(hashed)
      const result = prev
        ? await pollGroup(items, prev, historyMinutes)
        : await seedGroup(items, historyMinutes)
      // Only the live key's accumulator can ever be read again; anything else
      // belongs to a superseded signature or selection and would otherwise keep
      // growing for the page's lifetime as an admin retunes bindings.
      accumRef.current.clear()
      accumRef.current.set(hashed, result)
      return result
    },
    // Cadence drives the interval only — never the key. Fold it in and every
    // cadence change would discard the accumulated history and re-seed.
    refetchInterval: pollSeconds * 1000,
    // A SCADA wall display must not freeze in a background tab.
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
  })

  // --- derivation ----------------------------------------------------------
  // Carried across ticks, so it cannot live in a memo: React may discard and
  // recompute one, which would replay every pulse and duplicate every event.
  const prevTagsRef = useRef({})
  const pulsesRef = useRef({})
  const eventsRef = useRef([])
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)

  // A stamp of when the query last produced data (or errored) is what actually
  // says "there is something new to derive" — `query` itself is a fresh object
  // on every render.
  const stamp = `${query.dataUpdatedAt}:${query.errorUpdatedAt}`
  const dataRef = useRef(query.data)
  dataRef.current = query.data
  const itemsRef = useRef(items)
  itemsRef.current = items
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
    const data = dataRef.current
    const anyData = !!data

    if (data) {
      itemsRef.current.forEach(({ nodeId }) => {
        readings[nodeId] = data.latest[nodeId] ?? null
        history[nodeId] = data.points[nodeId] ?? []
      })
    }

    const tags = {}
    const fresh = []
    const unreachableMs = unreachableAfterMs(pollSeconds)
    let unreadable = 0
    boundRef.current.forEach((node) => {
      const reading = readings[node.id] ?? null
      // "We can't reach it" is a different fault from "what it holds is old",
      // and only the first is a connection problem — a historian that stopped
      // being written to three weeks ago answers every query perfectly. So
      // this counts fetch freshness (`okAt`), never the row's own timestamp.
      const okAt = reading?.okAt ?? 0
      if (now - okAt > unreachableMs) unreadable += 1
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
        ? connectionErrorMessage(data?.sources)
        : '',
      sources: data?.sources || [],
    })
  }, [stamp, enabled, pollSeconds, bound.length])

  return snapshot
}
