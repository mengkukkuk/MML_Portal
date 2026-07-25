import { useCallback, useMemo } from 'react'
import { compileExpr } from '@/utils/mathExpr'
import { colorAt } from '@/utils/seriesPalette'
import { alertingSeries } from '@/utils/alertConditions'
import { GENERIC_VIZ_TYPES, HEADER_VALUE_VIZ_TYPES } from './options'

// Poll interval selector — values are seconds, kept in sync with backend whitelist.
export const POLL_INTERVALS = [
  { value: 5, label: '5s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
]

// Time-range selector — how far back this tile's chart/history fetches go.
// A view-only preference (not persisted to the panel record), so any viewer
// can widen or narrow their own window independent of the admin's config.
export const TIME_RANGES = [
  { value: 10, label: 'Last 10 min' },
  { value: 30, label: 'Last 30 min' },
  { value: 60, label: 'Last 1 hour' },
  { value: 480, label: 'Last 8 hours' },
  { value: 1440, label: 'Last 24 hours' },
  { value: 10080, label: 'Last week' },
]

// Normalize legacy "line" panels to the time-series renderer.
function normalizeVizType(chartType) {
  return chartType === 'line' ? 'timeseries' : chartType
}

/**
 * usePanelSeries — the "what to fetch and how to interpret it" half of
 * LivePanel. Pure derivation from `panel` (+ the viewer's local series-value
 * override): source dispatch (device|tag|table), cartesian expansion of
 * options.value_cols x options.filters (table source) or options.tags (tag
 * source), the compiled math-transform function, and a stable per-series
 * unit resolver. Carries none of the live polling state — see
 * usePanelPolling for that, and `buildSeriesList`/`computeAlertSeries` below
 * for combining the two.
 *
 * Every array/function this returns is useMemo'd (or useCallback'd) with
 * primitive/array deps so identity stays stable across renders that don't
 * actually change the panel's data binding — required so downstream
 * useMemo's (seriesList, the ECharts option objects) don't rebuild on every
 * render and defeat <EChart>'s notMerge diffing.
 */
export function usePanelSeries(panel, { filterOverride = null } = {}) {
  const isTag = panel.source === 'tag'
  const isTable = panel.source === 'table'
  const opts = panel.options || {}
  const vizType = normalizeVizType(panel.chart_type)

  // Table source: chosen value columns x filter values expand into one
  // series each. When no filter column is set the panel collapses to one
  // series per value column.
  const tableValueCols = useMemo(() => {
    const extras = opts.value_cols
    const list = [panel.metric, ...(Array.isArray(extras) ? extras : [])]
    return list.filter(Boolean)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.metric, opts.value_cols])

  const tableFilters = useMemo(() => {
    const f = opts.filters
    return Array.isArray(f) ? f.filter(Boolean) : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.filters])

  // What seriesSpecs actually fetches: the viewer's override when set, else
  // the panel's configured filter values.
  const effectiveFilters = useMemo(
    () => (filterOverride != null ? [filterOverride] : tableFilters),
    [filterOverride, tableFilters],
  )

  const tableHasFilter = !!panel.filter_col && effectiveFilters.length > 0
  const showFilterChanger = isTable && !!panel.filter_col && tableFilters.length === 1

  // Canonical series model: one entry per output series carrying everything
  // needed to fetch and render it.
  const seriesSpecs = useMemo(() => {
    if (isTag) {
      const tags = opts.tags
      const list = Array.isArray(tags) && tags.length ? tags : (panel.tag_name ? [panel.tag_name] : [])
      return list.filter(Boolean).map((t) => ({
        key: t, label: t, valueCol: panel.metric, filterVal: null, unitKey: t,
      }))
    }
    if (isTable) {
      const vcs = tableValueCols
      const fvs = tableHasFilter ? effectiveFilters : [null]
      const multiVc = vcs.length > 1
      const specs = []
      for (const vc of vcs) {
        for (const fv of fvs) {
          // Encode (vc, fv) into a stable key. JSON encoding is
          // collision-safe against value strings containing separators.
          const key = JSON.stringify([vc, fv])
          const label = multiVc && fv != null ? `${vc} · ${fv}` : (fv != null ? fv : vc)
          specs.push({ key, label, valueCol: vc, filterVal: fv, unitKey: fv != null ? fv : vc })
        }
      }
      return specs
    }
    // Device source: a single series keyed by its metric.
    return panel.metric
      ? [{ key: panel.metric, label: panel.metric, valueCol: panel.metric, filterVal: null, unitKey: panel.metric }]
      : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTag, isTable, opts.tags, panel.tag_name, panel.metric, tableValueCols, tableHasFilter, effectiveFilters])

  // Legacy alias: the bare series keys — folded into the deep-watch Query key.
  const seriesTags = useMemo(() => seriesSpecs.map((s) => s.key), [seriesSpecs])

  // Per-panel math transform: applied to every reading at ingest time so all
  // renderers (and warn/crit thresholds) see post-transform numbers.
  const mathFn = useMemo(() => compileExpr(opts.mathExpr || '').fn, [opts.mathExpr])

  const isMulti = seriesSpecs.length > 1
  const isGeneric = GENERIC_VIZ_TYPES.has(vizType)
  const showHeaderValue = HEADER_VALUE_VIZ_TYPES.has(vizType)

  // Admin-declared display units (options.units), keyed per series — by
  // filter value when filtered, else by value column.
  const unitsMap = opts.units
  // Resolve a series' unit: series-key unit -> legacy per-column unit ->
  // device fallback -> none. The valueCol term keeps old column-keyed panels
  // working. useCallback (not a plain closure) so its identity only changes
  // when the admin-declared units map actually changes.
  const unitFor = useCallback((spec, deviceUnit) => (
    (unitsMap && unitsMap[spec.unitKey]) || (unitsMap && unitsMap[spec.valueCol]) || deviceUnit || ''
  ), [unitsMap])

  return {
    vizType, opts, isTag, isTable,
    tableValueCols, tableFilters, effectiveFilters, tableHasFilter, showFilterChanger,
    seriesSpecs, seriesTags, mathFn, isMulti, isGeneric, showHeaderValue, unitFor,
  }
}

/**
 * Combine the static seriesSpecs with live polling state into the hydrated
 * view model every renderer consumes (colour, resolved unit, points,
 * latest). Exported as a plain function (not a hook) so LivePanel.jsx can
 * wrap it in its own useMemo alongside the polling data it depends on.
 */
export function buildSeriesList(seriesSpecs, { seriesPoints, seriesLatest, unitFor, deviceUnit }) {
  return seriesSpecs.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: colorAt(i),
    valueCol: s.valueCol,
    unitKey: s.unitKey,
    unit: unitFor(s, deviceUnit),
    points: seriesPoints[s.key] || [],
    latest: seriesLatest[s.key] || null,
  }))
}

/**
 * Series currently in alert — the de-duped union of every true condition's
 * referenced series. Recomputes each poll via the hydrated seriesList.
 */
export function computeAlertSeries(panel, seriesList) {
  const conds = panel.options?.conditions
  if (!Array.isArray(conds) || !conds.length) return []
  const vars = {}
  for (const s of seriesList) if (s.latest) vars[s.valueCol] = s.latest.value
  return alertingSeries(conds, vars)
}
