import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { fetchSeries, fetchLatest } from '@/api/readings'
import { fetchTagLatest } from '@/api/tags'
import { fetchSchemaLatest, fetchSchemaSeries } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { applyExpr } from '@/utils/mathExpr'
import {
  mergeSources, sourcesFromError, connectionErrorMessage, isConnectionError,
} from '@/utils/sourceHealth'

const POLL_RETRY_DELAY_MS = 4000

// Never blank the chart: if every point has aged out of the window (a stale
// or lagging source), keep the most recent one so time-series/bar still
// show it.
function trimWindow(arr, rangeMinutes) {
  const cutoff = Date.now() - rangeMinutes * 60_000
  const kept = arr.filter(([t]) => t >= cutoff)
  return kept.length ? kept : arr.slice(-1)
}

function errorFor(anyOk, anyFailed, sources) {
  if (anyOk) return ''
  if (anyFailed) return connectionErrorMessage(sources)
  return 'No value reported.'
}

// --- per-source series identity -------------------------------------------
// Every data endpoint now answers for all selected sources at once, so one
// configured series (a tag, or a value-column x filter-value pair) fans out
// into one rendered series per source. The datasource id has to be part of
// the series key: two plants routinely use the same tag name and the same
// column, and without it their readings would land in the same accumulator
// bucket and be drawn as a single line zig-zagging between two plants.
const seriesKey = (baseKey, datasourceId) => JSON.stringify([datasourceId ?? null, baseKey])

/**
 * Expand the panel's configured specs across the sources named in a response
 * envelope.
 *
 * The envelope's `sources` lists every selected source, including any that
 * failed this round, so a plant that drops out for one poll keeps its series
 * — and therefore its palette colour — instead of the whole chart reshuffling
 * underneath the operator and reshuffling back a second later.
 *
 * With a single source the labels are left exactly as configured, so existing
 * dashboards look identical to before the header selector existed.
 */
function expandSpecs(seriesSpecs, sources) {
  const list = sources?.length ? sources : [{ datasource_id: null, datasource_name: null }]
  const multi = list.length > 1
  const out = []
  for (const spec of seriesSpecs) {
    for (const src of list) {
      const dsId = src.datasource_id ?? null
      const name = src.datasource_name || (dsId != null ? `source ${dsId}` : '')
      out.push({
        ...spec,
        key: seriesKey(spec.key, dsId),
        baseKey: spec.key,
        label: multi && name ? `${name} · ${spec.label}` : spec.label,
        datasourceId: dsId,
        datasourceName: src.datasource_name ?? null,
      })
    }
  }
  return out
}

// A round where every source failed reads as "no data" from the rows alone —
// the arrays are simply empty. The reports are the only place that difference
// is visible, and it decides whether the tile says "retrying" or "no value".
const allSourcesFailed = (sources) => !!sources?.length && sources.every((s) => !s.ok)

// --- poll: incremental fetch, appends onto the previous accumulator -------
async function pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev }) {
  const prevPoints = prev?.points || {}
  const prevLatest = prev?.latest || {}
  const prevUnit = prev?.unit || ''
  // Every request in a round carries the same selection, so the first envelope
  // to arrive names the full source set. If none did (total failure) the
  // previous round's expansion is the honest thing to keep showing.
  const specsFrom = (sources) => (sources ? expandSpecs(seriesSpecs, sources) : prev?.specs || [])

  if (isTag) {
    // Fetch every tag concurrently; one dead tag must not blank the panel.
    const results = await Promise.allSettled(seriesSpecs.map((s) => fetchTagLatest(s.key)))
    // variables_tag has no history — sample at the poll wall-clock time so
    // the line advances every poll and looks live even when steady.
    const sampleT = Date.now()
    const points = { ...prevPoints }
    const latest = { ...prevLatest }
    const sourceLists = []
    let anyOk = false
    let anyFailed = false
    results.forEach((res, i) => {
      const spec = seriesSpecs[i]
      if (res.status !== 'fulfilled') {
        anyFailed = true
        // A total outage across every selected source collapses to a single
        // 404 (see tags.py's `/latest`) rather than the usual fulfilled
        // envelope, but the per-source report still rides in its body — pull
        // it out so a real "MML Test is down" survives instead of vanishing
        // into a bare rejection.
        const errSources = sourcesFromError(res.reason)
        if (errSources) sourceLists.push(errSources)
        console.error('[live-panel] tag fetch failed:', spec.key, res.reason)
        return
      }
      sourceLists.push(res.value.sources)
      for (const row of res.value.tags) {
        const raw = row[panel.metric]
        if (raw == null) continue
        anyOk = true
        const value = applyExpr(mathFn, raw)
        const key = seriesKey(spec.key, row.datasource_id)
        const arr = points[key] || []
        points[key] = trimWindow([...arr, [sampleT, value]], rangeMinutes)
        latest[key] = { value, ts: row.ts || new Date(sampleT).toISOString() }
      }
    })
    // Every configured tag fans out over the identical selection, so a source
    // that any one of these concurrent requests caught mid-failure is really
    // down — don't let a luckier sibling request's "ok" hide it.
    const sources = mergeSources(sourceLists)
    if (allSourcesFailed(sources)) anyFailed = true
    return {
      points, latest, unit: prevUnit, specs: specsFrom(sources),
      sources: sources || prev?.sources || null,
      error: errorFor(anyOk, anyFailed, sources || prev?.sources), updated: anyOk,
    }
  }

  if (isTable) {
    const results = await Promise.allSettled(seriesSpecs.map((s) => fetchSchemaLatest({
      table: panel.table_name, valueCol: s.valueCol, filterCol: panel.filter_col,
      filterVal: s.filterVal, tsCol: panel.ts_col,
    })))
    const sampleT = Date.now()
    const points = { ...prevPoints }
    const latest = { ...prevLatest }
    const sourceLists = []
    let anyOk = false
    let anyFailed = false
    results.forEach((res, i) => {
      const spec = seriesSpecs[i]
      if (res.status !== 'fulfilled') {
        anyFailed = true
        // See the isTag branch above: a total outage across every selected
        // source is a rejection here, not a fulfilled envelope, but the
        // per-source report still rides along in the error body.
        const errSources = sourcesFromError(res.reason)
        if (errSources) sourceLists.push(errSources)
        console.error('[live-panel] series fetch failed:', spec.key, res.reason)
        return
      }
      sourceLists.push(res.value.sources)
      for (const row of res.value.readings) {
        if (row.value == null) continue
        anyOk = true
        const value = applyExpr(mathFn, row.value)
        // Real history tables carry a row timestamp; append only when it
        // advances. Current-state tables (no ts_col) sample at wall-clock so
        // steady values still move the line forward.
        const t = panel.ts_col && row.ts ? new Date(row.ts).getTime() : sampleT
        const key = seriesKey(spec.key, row.datasource_id)
        const arr = points[key] || []
        const lastT = arr.length ? arr[arr.length - 1][0] : -1
        if (t > lastT) points[key] = trimWindow([...arr, [t, value]], rangeMinutes)
        latest[key] = { value, ts: row.ts || new Date(sampleT).toISOString() }
      }
    })
    const sources = mergeSources(sourceLists)
    if (allSourcesFailed(sources)) anyFailed = true
    return {
      points, latest, unit: prevUnit, specs: specsFrom(sources),
      sources: sources || prev?.sources || null,
      error: errorFor(anyOk, anyFailed, sources || prev?.sources), updated: anyOk,
    }
  }

  // Device source.
  const spec = seriesSpecs[0]
  if (!spec) return { points: prevPoints, latest: prevLatest, unit: prevUnit, specs: [], sources: prev?.sources || null, error: '', updated: false }
  try {
    const res = await fetchLatest(panel.device_id, panel.metric)
    const points = { ...prevPoints }
    const latest = { ...prevLatest }
    let unit = prevUnit
    let anyOk = false
    for (const r of res.readings) {
      if (r.value == null) continue
      anyOk = true
      unit = r.unit || unit
      const key = seriesKey(spec.key, r.datasource_id)
      const t = new Date(r.ts).getTime()
      const arr = points[key] || []
      const lastT = arr.length ? arr[arr.length - 1][0] : -1
      const value = applyExpr(mathFn, r.value)
      if (t > lastT) points[key] = trimWindow([...arr, [t, value]], rangeMinutes)
      latest[key] = { value, ts: r.ts }
    }
    return {
      points, latest, unit, specs: expandSpecs(seriesSpecs, res.sources),
      sources: res.sources || null,
      error: errorFor(anyOk, allSourcesFailed(res.sources), res.sources), updated: anyOk,
    }
  } catch (e) {
    const carried = { points: prevPoints, latest: prevLatest, unit: prevUnit, specs: prev?.specs || [], sources: prev?.sources || null, updated: false }
    if (e?.response?.status === 404) {
      return { ...carried, error: 'No readings yet for this connection.' }
    }
    console.error('[live-panel] latest fetch failed:', panel.device_id, panel.metric, e)
    // A hard rejection (not a per-source ok=false) still carries `sources` in
    // its body when the backend caught a total outage (see `_raise_if_all_failed`);
    // falling back to the previous round's report otherwise still names the
    // right source rather than going generic the instant a poll hiccups.
    const errSources = sourcesFromError(e) || carried.sources
    return { ...carried, sources: errSources, error: connectionErrorMessage(errSources) }
  }
}

// --- seed: initial full-window fetch (or delegate to poll for sources with
// no server-side history) --------------------------------------------------
async function seedFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes }) {
  // Sources with no server-side history seed by delegating to poll(). The
  // per-source keys are unknown until a response names them, so the empty
  // accumulator starts out genuinely empty rather than pre-keyed.
  const emptyPrev = { points: {}, latest: {}, unit: '', specs: [] }

  if (isTag) {
    // variables_tag has no native history — start empty, accumulate via
    // polling (poll() also emits `updated`, matching Vue's seed() which
    // literally delegates to poll() for this source).
    return pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev: emptyPrev })
  }

  if (isTable) {
    // With a timestamp column we can seed real history; otherwise start
    // empty and let polling accumulate (like the tag source).
    if (!panel.ts_col) {
      return pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev: emptyPrev })
    }
    const results = await Promise.allSettled(
      seriesSpecs.map((s) => fetchSchemaSeries({
        table: panel.table_name, valueCol: s.valueCol, tsCol: panel.ts_col,
        filterCol: panel.filter_col, filterVal: s.filterVal, minutes: rangeMinutes,
      })),
    )
    const points = {}
    const latest = {}
    const sourceLists = []
    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') {
        const errSources = sourcesFromError(res.reason)
        if (errSources) sourceLists.push(errSources)
        return
      }
      sourceLists.push(res.value.sources)
      for (const one of res.value.series) {
        const key = seriesKey(seriesSpecs[i].key, one.datasource_id)
        const arr = one.points.map((p) => [new Date(p.ts).getTime(), applyExpr(mathFn, p.value)])
        points[key] = arr
        if (arr.length) {
          const last = one.points[one.points.length - 1]
          latest[key] = { value: applyExpr(mathFn, last.value), ts: last.ts }
        }
      }
    })
    const sources = mergeSources(sourceLists)
    const specs = expandSpecs(seriesSpecs, sources)
    for (const s of specs) if (!points[s.key]) points[s.key] = []

    // Stale-source fallback: any series with no windowed history falls back
    // to its latest reading, so a quiet source shows its last value instead
    // of blank. Fetched once per configured spec (not per expanded series) —
    // one request already answers for every source.
    const emptyBases = seriesSpecs.filter(
      (base) => specs.some((s) => s.baseKey === base.key && !points[s.key].length),
    )
    if (emptyBases.length) {
      const fallbacks = await Promise.allSettled(
        emptyBases.map((s) => fetchSchemaLatest({
          table: panel.table_name, valueCol: s.valueCol, filterCol: panel.filter_col,
          filterVal: s.filterVal, tsCol: panel.ts_col,
        })),
      )
      fallbacks.forEach((res, j) => {
        if (res.status !== 'fulfilled') return
        for (const row of res.value.readings) {
          if (row.value == null) continue
          const key = seriesKey(emptyBases[j].key, row.datasource_id)
          if (points[key]?.length) continue
          const v = applyExpr(mathFn, row.value)
          const t = row.ts ? new Date(row.ts).getTime() : Date.now()
          points[key] = [[t, v]]
          latest[key] = { value: v, ts: row.ts || new Date(t).toISOString() }
        }
      })
    }
    return { points, latest, unit: '', specs, sources: sources || null, error: '', updated: false }
  }

  // Device source.
  const spec = seriesSpecs[0]
  if (!spec) return { points: {}, latest: {}, unit: '', specs: [], sources: null, error: '', updated: false }
  try {
    const res = await fetchSeries(panel.device_id, panel.metric, rangeMinutes)
    const specs = expandSpecs(seriesSpecs, res.sources)
    const points = {}
    const latest = {}
    let unit = ''
    const emptySources = []
    for (const one of res.series) {
      unit = one.unit || unit
      const key = seriesKey(spec.key, one.datasource_id)
      const arr = one.points.map((p) => [new Date(p.ts).getTime(), applyExpr(mathFn, p.value)])
      points[key] = arr
      if (arr.length) {
        const last = one.points[one.points.length - 1]
        latest[key] = { value: applyExpr(mathFn, last.value), ts: last.ts }
      } else {
        emptySources.push(one.datasource_id)
      }
    }
    for (const s of specs) if (!points[s.key]) points[s.key] = []

    // Stale-source fallback: no readings in the window -> seed the latest one.
    if (emptySources.length || !res.series.length) {
      const r = await fetchLatest(panel.device_id, panel.metric).catch(() => null)
      for (const row of r?.readings || []) {
        if (row.value == null) continue
        const key = seriesKey(spec.key, row.datasource_id)
        if (points[key]?.length) continue
        const v = applyExpr(mathFn, row.value)
        points[key] = [[new Date(row.ts).getTime(), v]]
        latest[key] = { value: v, ts: row.ts }
        unit = row.unit || unit
      }
    }
    return { points, latest, unit, specs, sources: res.sources || null, error: '', updated: false }
  } catch (e) {
    return { points: {}, latest: {}, unit: '', specs: [], sources: null, error: e?.message || 'Failed to load series.', updated: false }
  }
}

const PULSE_MS = 450

/**
 * Latch each rising edge of `active` on for `ms`.
 *
 * A poll against a LAN backend completes in ~20ms, so `isFetching` alone
 * flickers far too briefly to register as feedback. Holding each fetch for a
 * fixed minimum turns it into a deliberate, readable pulse. Falling edges are
 * ignored on purpose — only the timer clears the latch, so a fast response
 * can't cut the pulse short.
 */
function usePulse(active, ms) {
  const [on, setOn] = useState(false)
  const wasActive = useRef(false)

  useEffect(() => {
    if (active && !wasActive.current) setOn(true)
    wasActive.current = active
  }, [active])

  useEffect(() => {
    if (!on) return undefined
    const id = setTimeout(() => setOn(false), ms)
    return () => clearTimeout(id)
  }, [on, ms])

  return on
}

/**
 * usePanelPolling — TanStack Query wrapper around seed()/poll().
 *
 * Query key carries the 9 fields LivePanel.vue's deep watch re-seeds on:
 * [panel.source, panel.device_id, panel.metric, rangeMinutes, seriesTags,
 * panel.table_name, panel.filter_col, panel.ts_col] plus the header's
 * datasource selection.
 *
 * The selection is in the key rather than merely invalidated, and that is
 * load-bearing. The accumulator below is keyed by the hashed query key: a
 * refetch under an unchanged key takes the *poll* path and appends onto the
 * previous accumulator. Invalidate without changing the key and the newly
 * selected plant's points would be merged into the old plant's accumulated
 * series — one continuous line silently splicing two plants together.
 * (`panel.datasource_id` is deliberately absent: the header now decides where
 * data comes from, and the panel field only steers the editor's catalogue
 * browsing.) `refreshSignal` is folded in as a 10th field (Vue's
 * `watch(refreshSignal)` calls the exact same full seed() as the 9-field
 * watcher) — React's effects fire on mount unlike Vue's watch, so a naive
 * `useEffect(() => seed(), [refreshSignal])` would double the seed request
 * on every mount; folding it into the key instead means each refreshSignal
 * bump is just "a new key", handled by the one seed/poll path below with no
 * separate effect.
 *
 * A hashed-key -> accumulator Map (in a ref, not React state) plays the role
 * of Vue's seriesPoints/seriesLatest refs: the first queryFn call for a
 * given key runs seedFetch (full window / tag-poll bootstrap), every
 * subsequent call under the SAME key runs pollFetch (incremental append +
 * sliding-window trim). A key change (any of the 10 fields) misses the map
 * and reseeds from scratch, matching Vue's watch-triggered seed() exactly.
 */
export function usePanelPolling({ panel, seriesSpecs, seriesTags, isTag, isTable, mathFn, rangeMinutes, refreshSignal = 0, onUpdated }) {
  const accumRef = useRef(new Map())
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const queryKey = useMemo(() => ([
    'live-panel-series',
    panel.source, panel.device_id, panel.metric,
    rangeMinutes, seriesTags,
    panel.table_name, panel.filter_col, panel.ts_col,
    selectionKey,
    refreshSignal,
  ]), [panel.source, panel.device_id, panel.metric, rangeMinutes, seriesTags, panel.table_name, panel.filter_col, panel.ts_col, selectionKey, refreshSignal])

  const hashedKey = useMemo(() => JSON.stringify(queryKey), [queryKey])
  const pollSeconds = panel.poll_interval_seconds || 5

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const prev = accumRef.current.get(hashedKey)
      const result = prev
        ? await pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev })
        : await seedFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes })
      // Only the live key's accumulator is worth keeping — any other entry
      // belongs to a superseded config (or an old refreshSignal) and can never
      // be read again, so without this the map grows for the page's lifetime.
      accumRef.current.clear()
      accumRef.current.set(hashedKey, result)
      if (result.updated) onUpdated?.(Date.now())
      return result
    },
    refetchInterval: pollSeconds * 1000,
    // SCADA wall display must not freeze in a hidden/background tab.
    refetchIntervalInBackground: true,
    // A key change (panel edited, range switched, manual Refresh) starts a
    // fresh query whose data is undefined until the seed lands. Without this
    // the tile blanks and the chart re-animates from empty every time; keeping
    // the previous render's data means the old values stay on screen and are
    // swapped in place, with `isFetching` driving the refresh affordance.
    placeholderData: keepPreviousData,
  })

  const pulse = usePulse(query.isFetching, PULSE_MS)

  // A failed poll (network error, timeout, gateway error) gets one quick
  // retry instead of waiting for the panel's full configured interval —
  // otherwise a single bad poll can strand a slow panel (10m/30m/1h) looking
  // "stuck" until its next scheduled tick. "No value reported." is deliberately
  // excluded: it is a legitimate empty-data state, not a fault.
  //
  // Two distinct failures both have to arm this, and they present differently.
  // A *source* outage still resolves the query — the backend fans out and
  // reports ok=false per source — so it shows up in `data.error`. A *backend*
  // outage rejects instead, and then `data` holds the last good round forever,
  // so `data.error` stays empty and only `isError` is true. Watching just the
  // first is what leaves a panel hanging until its next scheduled tick.
  //
  // `errorUpdatedAt` is in the deps so each successive failure re-arms the
  // timer: this is the reconnection poll, and it has to keep running for as
  // long as the outage lasts, not fire once.
  useEffect(() => {
    const down = isConnectionError(query.data?.error) || query.isError
    if (!down) return undefined
    const id = setTimeout(() => { query.refetch() }, POLL_RETRY_DELAY_MS)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, query.isError, query.errorUpdatedAt, hashedKey])

  return {
    seriesPoints: query.data?.points || {},
    seriesLatest: query.data?.latest || {},
    // The configured specs expanded across the sources that actually answered.
    // Null until the first response lands — the caller falls back to the
    // unexpanded specs so the tile can render its labels before any data.
    resolvedSpecs: query.data?.specs?.length ? query.data.specs : null,
    unit: query.data?.unit || '',
    // Per-source ok/error report from the most recent response that named
    // one — null until the first response lands. Lets a caller show which
    // named source is down rather than just that something is.
    sources: query.data?.sources || null,
    error: query.data?.error || (query.isError ? (query.error?.message || 'Failed to load series.') : ''),
    // First-ever load for this panel: nothing to show yet, so the tile renders
    // a skeleton rather than a row of em-dashes.
    isLoading: query.isLoading,
    // Any request in flight, including a routine incremental poll — latched to
    // a minimum duration so the header heartbeat is actually perceptible.
    isFetching: pulse,
    // A full re-seed is in flight and the values on screen are the previous
    // key's data being held over. Drives the stronger "refreshing" treatment.
    isReseeding: query.isPlaceholderData,
  }
}
