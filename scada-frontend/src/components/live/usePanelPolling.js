import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSeries, fetchLatest } from '@/api/readings'
import { fetchTagLatest } from '@/api/tags'
import { fetchSchemaLatest, fetchSchemaSeries } from '@/api/schema'
import { applyExpr } from '@/utils/mathExpr'

const POLL_RETRY_DELAY_MS = 4000
const CONNECTION_ERROR = 'Connection error — retrying…'

// Never blank the chart: if every point has aged out of the window (a stale
// or lagging source), keep the most recent one so time-series/bar still
// show it.
function trimWindow(arr, rangeMinutes) {
  const cutoff = Date.now() - rangeMinutes * 60_000
  const kept = arr.filter(([t]) => t >= cutoff)
  return kept.length ? kept : arr.slice(-1)
}

function errorFor(anyOk, anyFailed) {
  if (anyOk) return ''
  if (anyFailed) return CONNECTION_ERROR
  return 'No value reported.'
}

// --- poll: incremental fetch, appends onto the previous accumulator -------
async function pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev }) {
  const prevPoints = prev?.points || {}
  const prevLatest = prev?.latest || {}
  const prevUnit = prev?.unit || ''

  if (isTag) {
    // Fetch every tag concurrently; one dead tag must not blank the panel.
    const results = await Promise.allSettled(seriesSpecs.map((s) => fetchTagLatest(s.key)))
    // variables_tag has no history — sample at the poll wall-clock time so
    // the line advances every poll and looks live even when steady.
    const sampleT = Date.now()
    const points = { ...prevPoints }
    const latest = { ...prevLatest }
    let anyOk = false
    let anyFailed = false
    results.forEach((res, i) => {
      const spec = seriesSpecs[i]
      if (res.status !== 'fulfilled') {
        anyFailed = true
        console.error('[live-panel] tag fetch failed:', spec.key, res.reason)
        return
      }
      const raw = res.value[panel.metric]
      if (raw == null) return
      anyOk = true
      const value = applyExpr(mathFn, raw)
      const arr = points[spec.key] || []
      points[spec.key] = trimWindow([...arr, [sampleT, value]], rangeMinutes)
      latest[spec.key] = { value, ts: res.value.ts || new Date(sampleT).toISOString() }
    })
    return { points, latest, unit: prevUnit, error: errorFor(anyOk, anyFailed), updated: anyOk }
  }

  if (isTable) {
    const results = await Promise.allSettled(seriesSpecs.map((s) => fetchSchemaLatest({
      table: panel.table_name, valueCol: s.valueCol, filterCol: panel.filter_col,
      filterVal: s.filterVal, tsCol: panel.ts_col, datasourceId: panel.datasource_id,
    })))
    const sampleT = Date.now()
    const points = { ...prevPoints }
    const latest = { ...prevLatest }
    let anyOk = false
    let anyFailed = false
    results.forEach((res, i) => {
      const spec = seriesSpecs[i]
      if (res.status !== 'fulfilled') {
        anyFailed = true
        console.error('[live-panel] series fetch failed:', spec.key, res.reason)
        return
      }
      const raw = res.value.value
      if (raw == null) return
      anyOk = true
      const value = applyExpr(mathFn, raw)
      // Real history tables carry a row timestamp; append only when it
      // advances. Current-state tables (no ts_col) sample at wall-clock so
      // steady values still move the line forward.
      const t = panel.ts_col && res.value.ts ? new Date(res.value.ts).getTime() : sampleT
      const arr = points[spec.key] || []
      const lastT = arr.length ? arr[arr.length - 1][0] : -1
      if (t > lastT) points[spec.key] = trimWindow([...arr, [t, value]], rangeMinutes)
      latest[spec.key] = { value, ts: res.value.ts || new Date(sampleT).toISOString() }
    })
    return { points, latest, unit: prevUnit, error: errorFor(anyOk, anyFailed), updated: anyOk }
  }

  // Device source.
  const spec = seriesSpecs[0]
  if (!spec) return { points: prevPoints, latest: prevLatest, unit: prevUnit, error: '', updated: false }
  try {
    const r = await fetchLatest(panel.device_id, panel.metric)
    const unit = r.unit || prevUnit
    if (r.value == null) {
      return { points: prevPoints, latest: prevLatest, unit, error: 'No value reported.', updated: false }
    }
    const t = new Date(r.ts).getTime()
    const arr = prevPoints[spec.key] || []
    const lastT = arr.length ? arr[arr.length - 1][0] : -1
    const points = { ...prevPoints }
    const value = applyExpr(mathFn, r.value)
    if (t > lastT) points[spec.key] = trimWindow([...arr, [t, value]], rangeMinutes)
    const latest = { ...prevLatest, [spec.key]: { value, ts: r.ts } }
    return { points, latest, unit, error: '', updated: true }
  } catch (e) {
    if (e?.response?.status === 404) {
      return { points: prevPoints, latest: prevLatest, unit: prevUnit, error: 'No readings yet for this connection.', updated: false }
    }
    console.error('[live-panel] latest fetch failed:', panel.device_id, panel.metric, e)
    return { points: prevPoints, latest: prevLatest, unit: prevUnit, error: CONNECTION_ERROR, updated: false }
  }
}

// --- seed: initial full-window fetch (or delegate to poll for sources with
// no server-side history) --------------------------------------------------
async function seedFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes }) {
  if (isTag) {
    // variables_tag has no native history — start empty, accumulate via
    // polling (poll() also emits `updated`, matching Vue's seed() which
    // literally delegates to poll() for this source).
    const points = {}
    for (const s of seriesSpecs) points[s.key] = []
    return pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev: { points, latest: {}, unit: '' } })
  }

  if (isTable) {
    // With a timestamp column we can seed real history; otherwise start
    // empty and let polling accumulate (like the tag source).
    if (!panel.ts_col) {
      const points = {}
      for (const s of seriesSpecs) points[s.key] = []
      return pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev: { points, latest: {}, unit: '' } })
    }
    const results = await Promise.allSettled(
      seriesSpecs.map((s) => fetchSchemaSeries({
        table: panel.table_name, valueCol: s.valueCol, tsCol: panel.ts_col,
        filterCol: panel.filter_col, filterVal: s.filterVal, minutes: rangeMinutes,
        datasourceId: panel.datasource_id,
      })),
    )
    const points = {}
    const latest = {}
    results.forEach((res, i) => {
      const key = seriesSpecs[i].key
      points[key] = []
      if (res.status !== 'fulfilled') return
      const arr = res.value.points.map((p) => [new Date(p.ts).getTime(), applyExpr(mathFn, p.value)])
      points[key] = arr
      if (arr.length) {
        const last = res.value.points[res.value.points.length - 1]
        latest[key] = { value: applyExpr(mathFn, last.value), ts: last.ts }
      }
    })
    // Stale-source fallback: any series with no windowed history falls back
    // to its latest reading, so a quiet source shows its last value instead
    // of blank.
    const emptySpecs = seriesSpecs.filter((s) => !points[s.key].length)
    if (emptySpecs.length) {
      const fallbacks = await Promise.allSettled(
        emptySpecs.map((s) => fetchSchemaLatest({
          table: panel.table_name, valueCol: s.valueCol, filterCol: panel.filter_col,
          filterVal: s.filterVal, tsCol: panel.ts_col, datasourceId: panel.datasource_id,
        })),
      )
      fallbacks.forEach((res, j) => {
        if (res.status !== 'fulfilled' || res.value.value == null) return
        const s = emptySpecs[j]
        const v = applyExpr(mathFn, res.value.value)
        const t = res.value.ts ? new Date(res.value.ts).getTime() : Date.now()
        points[s.key] = [[t, v]]
        latest[s.key] = { value: v, ts: res.value.ts || new Date(t).toISOString() }
      })
    }
    return { points, latest, unit: '', error: '', updated: false }
  }

  // Device source.
  const spec = seriesSpecs[0]
  if (!spec) return { points: {}, latest: {}, unit: '', error: '', updated: false }
  try {
    const res = await fetchSeries(panel.device_id, panel.metric, rangeMinutes)
    const unit = res.unit || ''
    const arr = res.points.map((p) => [new Date(p.ts).getTime(), applyExpr(mathFn, p.value)])
    if (arr.length) {
      const last = res.points[res.points.length - 1]
      return {
        points: { [spec.key]: arr },
        latest: { [spec.key]: { value: applyExpr(mathFn, last.value), ts: last.ts } },
        unit, error: '', updated: false,
      }
    }
    // Stale-source fallback: no readings in the window -> seed the latest one.
    const r = await fetchLatest(panel.device_id, panel.metric).catch(() => null)
    if (r && r.value != null) {
      const v = applyExpr(mathFn, r.value)
      return {
        points: { [spec.key]: [[new Date(r.ts).getTime(), v]] },
        latest: { [spec.key]: { value: v, ts: r.ts } },
        unit: r.unit || unit, error: '', updated: false,
      }
    }
    return { points: { [spec.key]: [] }, latest: {}, unit, error: '', updated: false }
  } catch (e) {
    return { points: {}, latest: {}, unit: '', error: e?.message || 'Failed to load series.', updated: false }
  }
}

/**
 * usePanelPolling — TanStack Query wrapper around seed()/poll().
 *
 * Query key carries the 9 fields LivePanel.vue's deep watch re-seeds on,
 * verbatim: [panel.source, panel.device_id, panel.metric, rangeMinutes,
 * seriesTags, panel.table_name, panel.filter_col, panel.ts_col,
 * panel.datasource_id] — miss `datasource_id` and switching a panel to a
 * different saved connection would silently keep showing the old
 * connection's data. `refreshSignal` is folded in as a 10th field (Vue's
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

  const queryKey = useMemo(() => ([
    'live-panel-series',
    panel.source, panel.device_id, panel.metric,
    rangeMinutes, seriesTags,
    panel.table_name, panel.filter_col, panel.ts_col,
    panel.datasource_id,
    refreshSignal,
  ]), [panel.source, panel.device_id, panel.metric, rangeMinutes, seriesTags, panel.table_name, panel.filter_col, panel.ts_col, panel.datasource_id, refreshSignal])

  const hashedKey = useMemo(() => JSON.stringify(queryKey), [queryKey])
  const pollSeconds = panel.poll_interval_seconds || 5

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const prev = accumRef.current.get(hashedKey)
      const result = prev
        ? await pollFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes, prev })
        : await seedFetch({ panel, seriesSpecs, isTag, isTable, mathFn, rangeMinutes })
      accumRef.current.set(hashedKey, result)
      if (result.updated) onUpdated?.(Date.now())
      return result
    },
    refetchInterval: pollSeconds * 1000,
    // SCADA wall display must not freeze in a hidden/background tab.
    refetchIntervalInBackground: true,
  })

  // A failed poll (network error, timeout, gateway error) gets one quick
  // retry instead of waiting for the panel's full configured interval —
  // otherwise a single bad poll can strand a slow panel (10m/30m/1h) looking
  // "stuck" until its next scheduled tick. Only "Connection error" is
  // retried this way; "No value reported." is a legitimate empty-data state
  // and just waits for the next scheduled poll, matching Vue exactly.
  useEffect(() => {
    if (query.data?.error !== CONNECTION_ERROR) return undefined
    const id = setTimeout(() => { query.refetch() }, POLL_RETRY_DELAY_MS)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, hashedKey])

  return {
    seriesPoints: query.data?.points || {},
    seriesLatest: query.data?.latest || {},
    unit: query.data?.unit || '',
    error: query.data?.error || (query.isError ? (query.error?.message || 'Failed to load series.') : ''),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  }
}
