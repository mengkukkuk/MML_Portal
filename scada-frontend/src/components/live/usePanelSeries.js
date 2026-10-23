import { useCallback, useMemo } from 'react'
import { compileExpr } from '@/utils/mathExpr'
import { colorAt } from '@/utils/seriesPalette'
import { DEFAULT_BOOL_LABELS } from '@/utils/columnKinds'
import { seriesAlerts } from '@/utils/alertConditions'
import { GENERIC_VIZ_TYPES, HEADER_VALUE_VIZ_TYPES } from './options'
import { deriveSeriesSpecs } from './seriesModel'

// Poll interval selector — values are seconds, kept in sync with backend whitelist.
export const POLL_INTERVALS = [
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
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
 * usePanelPolling for that, and `buildSeriesList`/`computeSeriesAlerts` below
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

  // Canonical series model: one entry per *configured* series, carrying
  // everything needed to fetch and label it.
  //
  // Not the final rendered set. Each of these fans out into one series per
  // selected datasource, which only the response can tell us — usePanelPolling
  // expands them and returns the result as `resolvedSpecs`. There is still
  // exactly one request per entry here: the backend answers for every selected
  // source at once.
  const seriesSpecs = useMemo(() => {
    if (isTag) {
      const tags = opts.tags
      const list = Array.isArray(tags) && tags.length ? tags : (panel.tag_name ? [panel.tag_name] : [])
      return list.filter(Boolean).map((t) => ({
        key: t, label: t, valueCol: panel.metric, filterVal: null, unitKey: t,
      }))
    }
    if (isTable) {
      // Column x series value x array slot, with display names, unsplit columns
      // and text flags applied -- see seriesModel for the rules.
      return deriveSeriesSpecs({
        metric: panel.metric,
        valueCols: Array.isArray(opts.value_cols) ? opts.value_cols : [],
        filterCol: panel.filter_col,
        filters: effectiveFilters,
        unsplitCols: opts.unsplitCols,
        arraySlots: opts.arraySlots,
        columnLabels: opts.columnLabels,
        textCols: opts.textCols,
      })
    }
    // Device source: a single series keyed by its metric.
    return panel.metric
      ? [{ key: panel.metric, label: panel.metric, valueCol: panel.metric, filterVal: null, unitKey: panel.metric }]
      : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTag, isTable, opts.tags, opts.columnLabels, opts.unsplitCols, opts.arraySlots, opts.textCols, opts.value_cols, panel.tag_name, panel.metric, panel.filter_col, effectiveFilters])

  // Legacy alias: the bare series keys — folded into the deep-watch Query key.
  const seriesTags = useMemo(() => seriesSpecs.map((s) => s.key), [seriesSpecs])

  // Per-panel math transform: applied to every reading at ingest time so all
  // renderers (and warn/crit thresholds) see post-transform numbers.
  const mathFn = useMemo(() => compileExpr(opts.mathExpr || '').fn, [opts.mathExpr])

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
    seriesSpecs, seriesTags, mathFn, isGeneric, showHeaderValue, unitFor,
  }
}

/**
 * Combine the static seriesSpecs with live polling state into the hydrated
 * view model every renderer consumes (colour, resolved unit, points,
 * latest). Exported as a plain function (not a hook) so LivePanel.jsx can
 * wrap it in its own useMemo alongside the polling data it depends on.
 */
export function buildSeriesList(
  seriesSpecs,
  { seriesPoints, seriesLatest, seriesLimits, seriesPanelCols, unitFor, deviceUnit, boolCols, boolLabels },
) {
  const flags = new Set(boolCols || [])
  // Palette steps are handed out to drawn series only. A word has no line to
  // colour, and counting it would shift every series after it off the swatch
  // the editor showed -- the renderers index the palette by position in the
  // text-free list (LivePanel's plotList), which this keeps in step.
  let drawn = 0
  return seriesSpecs.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.isText ? 'var(--fg)' : colorAt(drawn++),
    valueCol: s.valueCol,
    // Which array slot this line reads (null for a scalar column), how an alert
    // condition names it, and whether it is a word rather than a number.
    slot: s.slot ?? null,
    varName: s.varName ?? s.valueCol,
    isText: !!s.isText,
    // Drawn once although a series column is set: its row is shared, not its own.
    unsplit: !!s.unsplit,
    // Row identity (source, filter value): alert conditions are judged per row.
    filterVal: s.filterVal ?? null,
    datasourceId: s.datasourceId ?? null,
    unitKey: s.unitKey,
    unit: unitFor(s, deviceUnit),
    // Keyed by column, not by series key, unlike `unit` just above: one flag
    // charted across forty devices is forty series of the same column, and
    // they all print the same two words.
    //
    // `boolCols` is what says the column is a flag; `boolLabels` only carries
    // the words *if someone changed them*. Defaulting here rather than at save
    // is what stops a panel saved straight past the editor's pre-filled
    // OFF/ON from drawing a bare 1.
    labels: flags.has(s.valueCol)
      ? (boolLabels?.[s.valueCol] ?? DEFAULT_BOOL_LABELS)
      : undefined,
    points: seriesPoints[s.key] || [],
    latest: seriesLatest[s.key] || null,
    // Live warn/crit setpoints from bound columns (gauge only); null = manual.
    limits: seriesLimits?.[s.key] || null,
    // Table columns alert conditions compare against (rhsType 'panel'); null = none.
    panelCols: seriesPanelCols?.[s.key] || null,
  }))
}

/**
 * Alerts per series — `{ [series.key]: { level, op, limit, rhsName, text } }`.
 * Each series is judged on its own row (its own reading and setpoint columns),
 * so two tags sharing one value column alert independently. Recomputes each
 * poll via the hydrated seriesList.
 */
export function computeSeriesAlerts(panel, seriesList) {
  return seriesAlerts(panel.options?.conditions, seriesList)
}
