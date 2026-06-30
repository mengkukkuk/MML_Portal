<script setup>
/**
 * LivePanel — a single self-polling tile in the Live dashboard grid.
 *
 * Renders one or more tag/device "connections" in a configurable Grafana-style
 * visualization: time series, bar, stat, gauge, bar gauge, histogram or table.
 * Tag-source panels can plot MULTIPLE tags at once (panel.options.tags) — each
 * tag becomes its own coloured series. The per-viz parameters (min/max,
 * thresholds, decimals, orientation, …) come from `panel.options`. Streams a
 * sliding-window series per tag, refreshing every poll interval. Series
 * value, time range, poll interval, and (for admins) Edit / Duplicate /
 * Delete all live behind the header's gear button.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, GaugeChart, PieChart, ScatterChart, HeatmapChart, CandlestickChart, CustomChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, VisualMapComponent } from 'echarts/components'
import { fetchSeries, fetchLatest } from '@/api/readings'
import { fetchTagLatest } from '@/api/tags'
import { fetchSchemaLatest, fetchSchemaSeries, fetchSchemaValues } from '@/api/schema'
import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { compileExpr, applyExpr } from '@/utils/mathExpr'
import { alertingSeries } from '@/utils/alertConditions'

use([CanvasRenderer, LineChart, BarChart, GaugeChart, PieChart, ScatterChart, HeatmapChart, CandlestickChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent])

const WARN_COLOR = '#e6a23c'
const CRIT_COLOR = '#f56c6c'

const props = defineProps({
  panel: { type: Object, required: true },
  deviceName: { type: String, default: '' },
  canManage: { type: Boolean, default: false },
  // Narrower than canManage: operators may change poll interval without
  // full panel-edit rights (Edit/Duplicate/Delete still gate on canManage).
  canChangePollInterval: { type: Boolean, default: false },
  editMode: { type: Boolean, default: false },
  // Bumped by the Live page's Refresh button to force an immediate re-fetch.
  refreshSignal: { type: Number, default: 0 },
})

const emit = defineEmits(['edit', 'duplicate', 'delete', 'poll-interval-change', 'updated'])

// Poll interval selector — values are seconds, kept in sync with backend whitelist.
const POLL_INTERVALS = [
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
const TIME_RANGES = [
  { value: 10, label: 'Last 10 min' },
  { value: 30, label: 'Last 30 min' },
  { value: 60, label: 'Last 1 hour' },
  { value: 480, label: 'Last 8 hours' },
  { value: 1440, label: 'Last 24 hours' },
  { value: 10080, label: 'Last week' },
]
const rangeMinutes = ref(10)

// Series-value changer — lets a viewer swap which single filter-column value
// (e.g. tag_name) a panel shows, without admin rights. View-only (not
// persisted): null means "use the panel's configured value". Only offered on
// panels configured with exactly one filter value — multi-value panels
// intentionally overlay several entities, so swapping one would be ambiguous.
const filterOverride = ref(null)
const availableFilters = ref([])

const pollSeconds = computed(() => props.panel.poll_interval_seconds || 5)
const isTag = computed(() => props.panel.source === 'tag')
const isTable = computed(() => props.panel.source === 'table')

// Table source: chosen value columns × filter values expand into one series each.
// When no filter column is set the panel collapses to one series per value column.
const tableValueCols = computed(() => {
  const extras = props.panel.options?.value_cols
  const list = [props.panel.metric, ...(Array.isArray(extras) ? extras : [])]
  return list.filter(Boolean)
})
const tableFilters = computed(() => {
  const f = props.panel.options?.filters
  return Array.isArray(f) ? f.filter(Boolean) : []
})
// What seriesSpecs actually fetches: the viewer's override when set, else the
// panel's configured filter values.
const effectiveFilters = computed(() => (
  filterOverride.value != null ? [filterOverride.value] : tableFilters.value
))
const tableHasFilter = computed(() => !!props.panel.filter_col && effectiveFilters.value.length > 0)
const showFilterChanger = computed(() => (
  isTable.value && !!props.panel.filter_col && tableFilters.value.length === 1
))

function onPollIntervalSelect(v) {
  emit('poll-interval-change', props.panel, v)
}

function onRangeSelect(v) {
  rangeMinutes.value = v
}

function onFilterValueSelect(v) {
  filterOverride.value = v
}

// All per-panel controls (series value, time range, poll interval, admin
// actions) collapse behind a single gear button so the header stays calm as
// more controls are added — see panel__gear / gearpop below. Open state
// drives the button's "live" glow, echoing the faceplate's lit-LCD signature.
const gearOpen = ref(false)

// Per-series data, keyed by series key (tag name for tag source, metric for
// device source). Reassigned immutably so ECharts' :option recomputes & repaints.
const seriesPoints = ref({}) // { [key]: [[epochMs, value], ...] }
const seriesLatest = ref({}) // { [key]: { value, ts } }
const unit = ref('')
const error = ref('')

let timer = null

// Normalize legacy "line" panels to the time-series renderer.
const vizType = computed(() => (props.panel.chart_type === 'line' ? 'timeseries' : props.panel.chart_type))
const opts = computed(() => props.panel.options || {})

// Canonical series model: one entry per output series carrying everything we
// need to fetch and render it. For the table source this expands the cartesian
// (value_cols × filter_values), so a panel can chart several columns AND
// several filter values at once. For tag/device sources it mirrors the legacy
// one-series-per-key shape.
const seriesSpecs = computed(() => {
  if (isTag.value) {
    const tags = props.panel.options?.tags
    const list = Array.isArray(tags) && tags.length
      ? tags
      : (props.panel.tag_name ? [props.panel.tag_name] : [])
    return list.filter(Boolean).map((t) => ({
      key: t, label: t, valueCol: props.panel.metric, filterVal: null, unitKey: t,
    }))
  }
  if (isTable.value) {
    const vcs = tableValueCols.value
    const fvs = tableHasFilter.value ? effectiveFilters.value : [null]
    const multiVc = vcs.length > 1
    const specs = []
    for (const vc of vcs) {
      for (const fv of fvs) {
        // Encode (vc, fv) into a stable key. JSON encoding is collision-safe
        // against value strings that happen to contain separators.
        const key = JSON.stringify([vc, fv])
        const label = multiVc && fv != null ? `${vc} · ${fv}` : (fv != null ? fv : vc)
        // Units key by the series-distinguishing value: filter value when
        // filtered, else the value column.
        specs.push({ key, label, valueCol: vc, filterVal: fv, unitKey: fv != null ? fv : vc })
      }
    }
    return specs
  }
  // Device source: a single series keyed by its metric.
  return props.panel.metric
    ? [{ key: props.panel.metric, label: props.panel.metric, valueCol: props.panel.metric, filterVal: null, unitKey: props.panel.metric }]
    : []
})

// Legacy alias: the bare series keys, still used by re-seed watchers below.
const seriesTags = computed(() => seriesSpecs.value.map((s) => s.key))

// Admin-declared display units (options.units), keyed per series — by filter
// value when filtered, else by value column.
const unitMap = computed(() => props.panel.options?.units || {})
// Resolve a series' unit: series-key unit → legacy per-column unit → device
// fallback → none. The valueCol term keeps old column-keyed panels working.
function unitFor(spec) {
  return unitMap.value[spec.unitKey] || unitMap.value[spec.valueCol] || unit.value || ''
}

// Hydrated view model for the renderers: one entry per series with its colour.
const seriesList = computed(() =>
  seriesSpecs.value.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: colorAt(i),
    valueCol: s.valueCol,
    unitKey: s.unitKey,
    unit: unitFor(s),
    points: seriesPoints.value[s.key] || [],
    latest: seriesLatest.value[s.key] || null,
  })),
)

// Unit shown in the single-value header (first/only series).
const headerUnit = computed(() => seriesList.value[0]?.unit || '')

// Series currently in alert — the de-duped union of every true condition's
// referenced series. Recomputes each poll via seriesLatest → seriesList.
// Renders a single red "… ALERTS" pill above the chart.
const alertSeries = computed(() => {
  const conds = props.panel.options?.conditions
  if (!Array.isArray(conds) || !conds.length) return []
  const vars = {}
  for (const s of seriesList.value) if (s.latest) vars[s.valueCol] = s.latest.value
  return alertingSeries(conds, vars)
})

const isMulti = computed(() => seriesList.value.length > 1)

const isGeneric = computed(() => ['timeseries', 'bar', 'histogram', 'bargauge', 'pie', 'heatmap', 'scatter', 'statetimeline', 'candlestick'].includes(vizType.value))
const showHeaderValue = computed(() => ['timeseries', 'bar', 'histogram', 'scatter'].includes(vizType.value))

const firstLatest = computed(() => seriesLatest.value[seriesSpecs.value[0]?.key] || null)

// Per-panel math transform: applied to every reading at ingest time so all
// renderers (and warn/crit thresholds) see post-transform numbers.
const mathFn = computed(() => compileExpr(props.panel.options?.mathExpr || '').fn)

function fmt(v) {
  if (v == null) return '—'
  const d = opts.value.decimals
  return d == null ? `${v}` : Number(v).toFixed(d)
}

// Threshold → colour. warn/crit are "value ≥" cut-offs; otherwise the series base.
function thColorWithThresholds(v, base, warn, crit) {
  if (crit != null && v >= crit) return CRIT_COLOR
  if (warn != null && v >= warn) return WARN_COLOR
  return base
}
function thColor(v, base = colorAt(0)) {
  return thColorWithThresholds(v, base, opts.value.warn, opts.value.crit)
}

// --- Shared ECharts fragments ----------------------------------------------
function legendCfg() {
  return isMulti.value
    ? { type: 'scroll', top: 0, textStyle: { color: '#8a99b3', fontSize: 10 }, itemWidth: 10, itemHeight: 10 }
    : undefined
}
const gridTop = () => (isMulti.value ? 30 : 12)
const timeAxis = () => ({ type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { show: false } })
// scale:false → axis keeps a zero baseline; max is pushed 20% above the data's
// peak so the top series never touches the chart edge.
function axisMax(v) {
  const m = v.max
  if (m > 0) return Math.round(m * 1.2)
  if (m < 0) return Math.round(m * 0.8) // less negative → headroom stays above the peak
  return 1                              // all-zero fallback
}
const valueAxis = () => ({ type: 'value', scale: false, max: axisMax, axisLine: { show: false }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } })
// Axis-trigger tooltip with a per-series unit suffix (valueFormatter can't see
// which series a value belongs to, so we build the rows ourselves).
const tooltipAxis = () => ({
  trigger: 'axis',
  backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
  formatter: (params) => {
    const arr = Array.isArray(params) ? params : [params]
    if (!arr.length) return ''
    const head = arr[0].axisValueLabel || new Date(arr[0].axisValue).toLocaleTimeString()
    const rows = arr.map((p) => {
      const v = Array.isArray(p.value) ? p.value[1] : p.value
      const u = seriesList.value[p.seriesIndex]?.unit || ''
      return `${p.marker}${p.seriesName}: ${fmt(v)}${u ? ' ' + u : ''}`
    })
    return [head, ...rows].join('<br/>')
  },
})

// --- Per-type ECharts option ----------------------------------------------
function timeseriesOption() {
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(),
    grid: { top: gridTop(), right: 14, bottom: 26, left: 46 },
    tooltip: tooltipAxis(),
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series: seriesList.value.map((s, i) => ({
      name: s.label,
      type: 'line',
      smooth: opts.value.smooth !== false,
      // Show a marker while the series has a single point so the latest reading
      // is visible instantly on refresh; symbols auto-hide once it's a line.
      showSymbol: s.points.length <= 1,
      symbolSize: 6,
      lineStyle: { width: opts.value.lineWidth || 2, color: colorAt(i) },
      // Skip area fills when overlaying multiple series (muddy when stacked).
      areaStyle: opts.value.area === false || isMulti.value ? undefined : { opacity: 0.1, color: colorAt(i) },
      data: s.points,
    })),
  }
}

function barOption() {
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(),
    grid: { top: gridTop(), right: 14, bottom: 26, left: 46 },
    tooltip: tooltipAxis(),
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series: seriesList.value.map((s, i) => ({
      name: s.label,
      type: 'bar',
      itemStyle: { color: colorAt(i), borderRadius: [2, 2, 0, 0] },
      data: s.points,
    })),
  }
}

// Bar gauge: one labelled, coloured bar per series (a "row" per tag).
function barGaugeOption() {
  const min = Number(opts.value.min ?? 0)
  const max = Number(opts.value.max ?? 100)
  const vertical = opts.value.orientation === 'vertical'
  const list = seriesList.value
  const data = list.map((s, i) => {
    const v = s.latest?.value ?? min
    return {
      value: v,
      itemStyle: { color: thColor(v, colorAt(i)), borderRadius: 4 },
      label: { show: true, position: vertical ? 'top' : 'right', color: '#e6edf7', fontSize: 12, formatter: () => `${fmt(v)}${s.unit ? ' ' + s.unit : ''}` },
    }
  })
  const vAxis = { type: 'value', min, max, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } }
  const cAxis = { type: 'category', data: list.map((s) => s.label), axisLabel: { show: isMulti.value, color: '#8a99b3', fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } }
  return {
    grid: { top: 16, bottom: 24, left: 16, right: 56, containLabel: true },
    tooltip: { backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } },
    xAxis: vertical ? cAxis : vAxis,
    yAxis: vertical ? vAxis : cAxis,
    series: [{ type: 'bar', barWidth: isMulti.value ? '55%' : '45%', data }],
  }
}

// Histogram: shared bucket range across every series, one coloured bar set each.
function histogramOption() {
  const all = seriesList.value.flatMap((s) => s.points.map((p) => p[1]))
  const n = Math.max(2, Number(opts.value.buckets ?? 20))
  let lo = Math.min(...all)
  let hi = Math.max(...all)
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) {
    hi = (lo || 0) + 1
    lo = lo || 0
  }
  const width = (hi - lo) / n
  const labels = Array.from({ length: n }, (_, i) => fmt(lo + i * width))
  const series = seriesList.value.map((s, i) => {
    const counts = new Array(n).fill(0)
    for (const x of s.points.map((p) => p[1])) {
      let bi = Math.floor((x - lo) / width)
      if (bi >= n) bi = n - 1
      if (bi < 0) bi = 0
      counts[bi] += 1
    }
    return { name: s.label, type: 'bar', itemStyle: { color: colorAt(i), borderRadius: [2, 2, 0, 0] }, data: counts }
  })
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(),
    grid: { top: gridTop(), right: 14, bottom: 30, left: 40 },
    tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8a99b3', fontSize: 9, interval: Math.ceil(n / 8) }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
    series,
  }
}

// Pie / Donut: latest value per series as proportional slices.
function pieOption() {
  const labelPos = opts.value.labelPosition || 'outside'
  const inner = opts.value.donut !== false ? `${opts.value.innerRadius ?? 50}%` : '0'
  const data = seriesList.value.map((s, i) => ({
    name: s.label,
    value: s.latest?.value ?? 0,
    itemStyle: { color: colorAt(i) },
  }))
  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
      formatter: (p) => {
        const u = seriesList.value[p.dataIndex]?.unit || ''
        return `${p.name}<br/>${fmt(p.value)}${u ? ' ' + u : ''} (${p.percent}%)`
      },
    },
    legend: legendCfg(),
    series: [{
      type: 'pie',
      radius: [inner, '72%'],
      center: ['50%', isMulti.value ? '55%' : '52%'],
      data,
      label: {
        show: labelPos !== 'none',
        position: labelPos === 'none' ? 'outside' : labelPos,
        color: '#8a99b3', fontSize: 11,
        formatter: '{b}: {d}%',
      },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
    }],
  }
}

// Heatmap: time buckets × series, cell color = average value in bucket.
function heatmapOption() {
  const bucketMs = Math.max(60_000, (opts.value.bucketMinutes ?? 5) * 60_000)
  const list = seriesList.value
  if (!list.length) return { series: [] }

  const allTs = list.flatMap(s => s.points.map(p => p[0]))
  if (!allTs.length) return {
    xAxis: { type: 'category', data: [] },
    yAxis: { type: 'category', data: list.map(s => s.label) },
    series: [{ type: 'heatmap', data: [] }],
  }

  const minT = Math.min(...allTs)
  const maxT = Math.max(...allTs)
  const numBuckets = Math.max(1, Math.ceil((maxT - minT) / bucketMs) + 1)
  const timeLabels = Array.from({ length: numBuckets }, (_, i) =>
    new Date(minT + i * bucketMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  )
  const seriesLabels = list.map(s => s.label)

  const heatData = []
  let dataMin = Infinity, dataMax = -Infinity
  list.forEach((s, yi) => {
    const bmap = Array.from({ length: numBuckets }, () => [])
    for (const [t, v] of s.points) {
      const bi = Math.min(numBuckets - 1, Math.floor((t - minT) / bucketMs))
      if (bi >= 0 && v != null) bmap[bi].push(v)
    }
    for (let xi = 0; xi < numBuckets; xi++) {
      const vals = bmap[xi]
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length
        heatData.push([xi, yi, avg])
        if (avg < dataMin) dataMin = avg
        if (avg > dataMax) dataMax = avg
      }
    }
  })
  if (!isFinite(dataMin)) dataMin = 0
  if (!isFinite(dataMax)) dataMax = 1

  const vMin = opts.value.colorMin ?? dataMin
  const vMax = opts.value.colorMax ?? dataMax

  return {
    tooltip: {
      backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
      formatter: (p) => {
        const [xi, yi, v] = p.data
        const u = seriesList.value[yi]?.unit || ''
        return `${seriesLabels[yi]}<br/>${timeLabels[xi]}<br/>${v != null ? fmt(v) : '—'}${u ? ' ' + u : ''}`
      },
    },
    grid: { top: 12, right: 60, bottom: 36, left: 80 },
    xAxis: {
      type: 'category', data: timeLabels,
      axisLabel: { color: '#8a99b3', fontSize: 9, interval: Math.ceil(numBuckets / 8), rotate: numBuckets > 10 ? 30 : 0 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
    },
    yAxis: {
      type: 'category', data: seriesLabels,
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    visualMap: {
      min: vMin, max: vMax, calculable: false, orient: 'vertical',
      right: 0, top: 'center',
      textStyle: { color: '#8a99b3', fontSize: 9 },
      inRange: { color: ['#22c55e', '#e6a23c', '#f56c6c'] },
    },
    series: [{ type: 'heatmap', data: heatData, itemStyle: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' } }],
  }
}

// Scatter: individual data points over time, one series per colour.
function scatterOption() {
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(),
    grid: { top: gridTop(), right: 14, bottom: 26, left: 46 },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
      formatter: (p) => {
        const u = seriesList.value[p.seriesIndex]?.unit || ''
        return `${p.seriesName}<br/>${new Date(p.data[0]).toLocaleTimeString()}: ${fmt(p.data[1])}${u ? ' ' + u : ''}`
      },
    },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series: seriesList.value.map((s, i) => ({
      name: s.label,
      type: 'scatter',
      symbolSize: opts.value.pointSize ?? 6,
      itemStyle: { color: colorAt(i), opacity: 0.75 },
      data: s.points,
    })),
  }
}

// State timeline: horizontal Gantt-style bands showing discrete state transitions.
function stateTimelineOption() {
  const list = seriesList.value
  if (!list.length) return { series: [] }
  const round = opts.value.roundValues !== false

  function stateKey(v) {
    return round ? String(Math.round(v ?? 0)) : fmt(v)
  }

  const stateSet = new Set()
  for (const s of list) {
    for (const [, v] of s.points) stateSet.add(stateKey(v))
  }
  const stateList = [...stateSet]
  const stateColors = stateList.map((_, i) => colorAt(i))

  const segments = []
  const now = Date.now()
  const categoryNames = list.map(s => s.label)

  list.forEach((s, yi) => {
    const pts = s.points
    if (!pts.length) return
    let segStart = pts[0][0]
    let segK = stateKey(pts[0][1])
    for (let i = 1; i < pts.length; i++) {
      const [t, v] = pts[i]
      const k = stateKey(v)
      if (k !== segK) {
        segments.push([segStart, t, yi, stateList.indexOf(segK)])
        segStart = t
        segK = k
      }
    }
    segments.push([segStart, now, yi, stateList.indexOf(segK)])
  })

  const BAND_H = 22
  return {
    tooltip: {
      backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
      formatter: (p) => {
        if (!Array.isArray(p.data)) return ''
        const [start, end, yi, si] = p.data
        const dur = Math.round((end - start) / 1000)
        const mins = Math.floor(dur / 60)
        const secs = dur % 60
        const durLabel = mins ? `${mins}m ${secs}s` : `${secs}s`
        return `${categoryNames[yi] ?? ''}<br/>State: <b>${stateList[si] ?? '?'}</b><br/>Duration: ${durLabel}`
      },
    },
    grid: { top: 8, right: 14, bottom: 24, left: 80 },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category', data: categoryNames,
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    },
    series: [{
      type: 'custom',
      renderItem(params, api) {
        const startV = api.value(0)
        const endV = api.value(1)
        const catI = api.value(2)
        const si = api.value(3)
        const catLabel = categoryNames[catI]
        const [x0, y0] = api.coord([startV, catLabel])
        const [x1] = api.coord([endV, catLabel])
        return {
          type: 'rect',
          shape: { x: x0, y: y0 - BAND_H / 2, width: Math.max(1, x1 - x0), height: BAND_H, r: 3 },
          style: api.style({ fill: stateColors[si] ?? '#4f8cff', opacity: 0.85 }),
        }
      },
      encode: { x: [0, 1], y: 2 },
      data: segments,
    }],
  }
}

// Candlestick: client-side OHLC aggregation into time buckets.
function candlestickOption() {
  const bucketMs = Math.max(60_000, (opts.value.bucketMinutes ?? 5) * 60_000)
  const series = seriesList.value.map((s, i) => {
    const bmap = new Map()
    for (const [t, v] of s.points) {
      const bStart = Math.floor(t / bucketMs) * bucketMs
      if (!bmap.has(bStart)) bmap.set(bStart, [])
      bmap.get(bStart).push(v)
    }
    const data = [...bmap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([t, vals]) => [t, vals[0], vals[vals.length - 1], Math.min(...vals), Math.max(...vals)])
    const col = colorAt(i)
    return {
      name: s.label,
      type: 'candlestick',
      data,
      itemStyle: { color: col, color0: col + '66', borderColor: col, borderColor0: col + '99' },
    }
  })
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(),
    grid: { top: gridTop(), right: 14, bottom: 26, left: 46 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' },
      formatter: (params) => {
        if (!Array.isArray(params) || !params.length) return ''
        const t = new Date(params[0].data?.[0]).toLocaleTimeString()
        const lines = params.map(p => {
          const [, o, c, lo, hi] = p.data ?? []
          return `${p.marker}${p.seriesName}: O:${fmt(o)} H:${fmt(hi)} L:${fmt(lo)} C:${fmt(c)}`
        })
        return [t, ...lines].join('<br/>')
      },
    },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series,
  }
}

// Per-series gauge override: panel.options.gaugeSeries[unitKey] = {min,max,
// decimals,warn,crit}, set by the admin editor. Any field left unset falls
// back to the gauge's shared (panel-wide) value, so an override only needs to
// name what differs for that one series.
function gaugeParamsFor(s) {
  const override = opts.value.gaugeSeries?.[s.unitKey] || {}
  return {
    min: override.min ?? Number(opts.value.min ?? 0),
    max: override.max ?? Number(opts.value.max ?? 100),
    decimals: override.decimals ?? opts.value.decimals,
    warn: override.warn ?? opts.value.warn,
    crit: override.crit ?? opts.value.crit,
  }
}

// Gauge: rendered as small multiples (one radial gauge per series, each
// resolving its own min/max/decimals/warn/crit via gaugeParamsFor).
function gaugeOptionFor(s, i) {
  const { min, max, decimals, warn, crit } = gaugeParamsFor(s)
  const span = max - min || 1
  const color = colorAt(i)
  const stops = []
  if (warn != null) stops.push([(warn - min) / span, color])
  if (crit != null) stops.push([(crit - min) / span, warn != null ? WARN_COLOR : color])
  stops.push([1, crit != null ? CRIT_COLOR : warn != null ? WARN_COLOR : color])
  const val = s.latest?.value ?? min
  const pc = thColorWithThresholds(val, color, warn, crit)
  const fmtGauge = (v) => (decimals == null ? `${v}` : Number(v).toFixed(decimals))
  return {
    series: [{
      type: 'gauge', min, max, radius: '92%', center: ['50%', '58%'],
      axisLine: { lineStyle: { width: 10, color: stops } },
      progress: { show: false },
      pointer: { width: 4, itemStyle: { color: pc } },
      axisTick: { show: false },
      splitLine: { length: 10, lineStyle: { color: 'rgba(255,255,255,0.25)' } },
      axisLabel: { color: '#8a99b3', fontSize: 9, distance: 12 },
      anchor: { show: true, size: 8, itemStyle: { color: pc } },
      detail: { valueAnimation: true, formatter: (v) => `${fmtGauge(v)}${s.unit ? ' ' + s.unit : ''}`, color: '#e6edf7', fontSize: isMulti.value ? 14 : 18, offsetCenter: [0, '78%'] },
      data: [{ value: val }],
    }],
  }
}

function sparklineOptionFor(s, i) {
  const color = colorAt(i)
  return {
    grid: { top: 4, right: 4, bottom: 4, left: 4 },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', scale: true, show: false },
    series: [{ type: 'line', smooth: true, showSymbol: s.points.length <= 1, symbolSize: 5, lineStyle: { width: 2, color }, areaStyle: { opacity: 0.15, color }, data: s.points }],
  }
}

const option = computed(() => {
  switch (vizType.value) {
    case 'bar': return barOption()
    case 'bargauge': return barGaugeOption()
    case 'histogram': return histogramOption()
    case 'pie': return pieOption()
    case 'heatmap': return heatmapOption()
    case 'scatter': return scatterOption()
    case 'statetimeline': return stateTimelineOption()
    case 'candlestick': return candlestickOption()
    default: return timeseriesOption()
  }
})

const chartStyle = computed(() => {
  if (vizType.value === 'statetimeline') {
    return { height: `${Math.max(120, seriesList.value.length * 44 + 40)}px` }
  }
  if (vizType.value === 'heatmap') {
    return { height: `${Math.max(160, seriesList.value.length * 34 + 60)}px` }
  }
  return {}
})

// --- Table rows (one value column per series) ------------------------------
const tableRows = computed(() => {
  const max = Math.max(1, Number(opts.value.maxRows ?? 10))
  const cols = seriesList.value
  const longest = cols.reduce((m, s) => Math.max(m, s.points.length), 0)
  const rows = []
  for (let k = 0; k < Math.min(max, longest); k++) {
    const cells = cols.map((s) => {
      const p = s.points[s.points.length - 1 - k]
      return p ? fmt(p[1]) : '—'
    })
    let t = ''
    for (const s of cols) {
      const p = s.points[s.points.length - 1 - k]
      if (p) { t = new Date(p[0]).toLocaleTimeString(); break }
    }
    rows.push({ t, cells })
  }
  return rows
})

// --- Polling ---------------------------------------------------------------
function trimWindow(arr) {
  const cutoff = Date.now() - rangeMinutes.value * 60_000
  const kept = arr.filter(([t]) => t >= cutoff)
  // Never blank the chart: if every point has aged out of the window (a stale or
  // lagging source), keep the most recent one so time-series/bar still show it.
  return kept.length ? kept : arr.slice(-1)
}

async function seed() {
  if (isTag.value) {
    // variables_tag has no native history — start empty, accumulate via polling.
    const init = {}
    for (const s of seriesSpecs.value) init[s.key] = []
    seriesPoints.value = init
    seriesLatest.value = {}
    unit.value = ''
    await poll()
    return
  }
  if (isTable.value) {
    unit.value = ''
    // With a timestamp column we can seed real history; otherwise start empty
    // and let polling accumulate (like the tag source).
    if (!props.panel.ts_col) {
      const init = {}
      for (const s of seriesSpecs.value) init[s.key] = []
      seriesPoints.value = init
      seriesLatest.value = {}
      await poll()
      return
    }
    const fn = mathFn.value
    const specs = seriesSpecs.value
    const results = await Promise.allSettled(
      specs.map((s) =>
        fetchSchemaSeries({
          table: props.panel.table_name,
          valueCol: s.valueCol,
          tsCol: props.panel.ts_col,
          filterCol: props.panel.filter_col,
          filterVal: s.filterVal,
          minutes: rangeMinutes.value,
          datasourceId: props.panel.datasource_id,
        }),
      ),
    )
    const nextPoints = {}
    const nextLatest = {}
    results.forEach((res, i) => {
      const key = specs[i].key
      nextPoints[key] = []
      if (res.status !== 'fulfilled') return
      const arr = res.value.points.map((p) => [new Date(p.ts).getTime(), applyExpr(fn, p.value)])
      nextPoints[key] = arr
      if (arr.length) {
        const last = res.value.points[res.value.points.length - 1]
        nextLatest[key] = { value: applyExpr(fn, last.value), ts: last.ts }
      }
    })
    // Stale-source fallback: any series with no windowed history falls back to
    // its latest reading, so a quiet source shows its last value instead of blank.
    const emptyTableSpecs = specs.filter((s) => !nextPoints[s.key].length)
    if (emptyTableSpecs.length) {
      const fallbacks = await Promise.allSettled(
        emptyTableSpecs.map((s) =>
          fetchSchemaLatest({
            table: props.panel.table_name,
            valueCol: s.valueCol,
            filterCol: props.panel.filter_col,
            filterVal: s.filterVal,
            tsCol: props.panel.ts_col,
            datasourceId: props.panel.datasource_id,
          }),
        ),
      )
      fallbacks.forEach((res2, j) => {
        if (res2.status !== 'fulfilled' || res2.value.value == null) return
        const s = emptyTableSpecs[j]
        const v = applyExpr(fn, res2.value.value)
        const t = res2.value.ts ? new Date(res2.value.ts).getTime() : Date.now()
        nextPoints[s.key] = [[t, v]]
        nextLatest[s.key] = { value: v, ts: res2.value.ts || new Date(t).toISOString() }
      })
    }
    seriesPoints.value = nextPoints
    seriesLatest.value = nextLatest
    error.value = ''
    return
  }
  try {
    const key = props.panel.metric
    const res = await fetchSeries(props.panel.device_id, props.panel.metric, rangeMinutes.value)
    unit.value = res.unit || ''
    const fn = mathFn.value
    const arr = res.points.map((p) => [new Date(p.ts).getTime(), applyExpr(fn, p.value)])
    if (arr.length) {
      seriesPoints.value = { [key]: arr }
      const last = res.points[res.points.length - 1]
      seriesLatest.value = { [key]: { value: applyExpr(fn, last.value), ts: last.ts } }
    } else {
      // Stale-source fallback: no readings in the window → seed the latest one.
      const r = await fetchLatest(props.panel.device_id, props.panel.metric).catch(() => null)
      if (r && r.value != null) {
        const v = applyExpr(fn, r.value)
        seriesPoints.value = { [key]: [[new Date(r.ts).getTime(), v]] }
        seriesLatest.value = { [key]: { value: v, ts: r.ts } }
        if (r.unit) unit.value = r.unit
      } else {
        seriesPoints.value = { [key]: [] }
        seriesLatest.value = {}
      }
    }
    error.value = ''
  } catch (e) {
    error.value = e?.message || 'Failed to load series.'
  }
}

async function poll() {
  if (isTag.value) {
    // Fetch every tag concurrently; one dead tag must not blank the panel.
    const results = await Promise.allSettled(seriesTags.value.map((t) => fetchTagLatest(t)))
    // variables_tag has no history — sample at the poll wall-clock time so the line
    // advances every poll and looks live even when the tag value is steady.
    const sampleT = Date.now()
    const nextPoints = { ...seriesPoints.value }
    const nextLatest = { ...seriesLatest.value }
    let anyOk = false
    const fn = mathFn.value
    results.forEach((res, i) => {
      const tag = seriesTags.value[i]
      if (res.status !== 'fulfilled') return
      const raw = res.value[props.panel.metric]
      if (raw == null) return
      anyOk = true
      const value = applyExpr(fn, raw)
      const arr = nextPoints[tag] || []
      nextPoints[tag] = trimWindow([...arr, [sampleT, value]])
      // Keep the tag's real update time for the "Updated …" header when present.
      nextLatest[tag] = { value, ts: res.value.ts || new Date(sampleT).toISOString() }
    })
    seriesPoints.value = nextPoints
    seriesLatest.value = nextLatest
    error.value = anyOk ? '' : 'No value reported.'
    if (anyOk) emit('updated', sampleT)
    return
  }
  if (isTable.value) {
    // Fetch every series concurrently; one dead series must not blank the panel.
    const specs = seriesSpecs.value
    const results = await Promise.allSettled(
      specs.map((s) =>
        fetchSchemaLatest({
          table: props.panel.table_name,
          valueCol: s.valueCol,
          filterCol: props.panel.filter_col,
          filterVal: s.filterVal,
          tsCol: props.panel.ts_col,
          datasourceId: props.panel.datasource_id,
        }),
      ),
    )
    const sampleT = Date.now()
    const nextPoints = { ...seriesPoints.value }
    const nextLatest = { ...seriesLatest.value }
    let anyOk = false
    let newest = 0
    const fn = mathFn.value
    results.forEach((res, i) => {
      const key = specs[i].key
      if (res.status !== 'fulfilled') return
      const raw = res.value.value
      if (raw == null) return
      anyOk = true
      const value = applyExpr(fn, raw)
      // Real history tables carry a row timestamp; append only when it advances.
      // Current-state tables (no ts_col) sample at wall-clock so steady values
      // still move the line forward.
      const t = props.panel.ts_col && res.value.ts ? new Date(res.value.ts).getTime() : sampleT
      const arr = nextPoints[key] || []
      const lastT = arr.length ? arr[arr.length - 1][0] : -1
      if (t > lastT) nextPoints[key] = trimWindow([...arr, [t, value]])
      nextLatest[key] = { value, ts: res.value.ts || new Date(sampleT).toISOString() }
      if (t > newest) newest = t
    })
    seriesPoints.value = nextPoints
    seriesLatest.value = nextLatest
    error.value = anyOk ? '' : 'No value reported.'
    if (anyOk) emit('updated', newest || sampleT)
    return
  }
  try {
    const key = props.panel.metric
    const r = await fetchLatest(props.panel.device_id, props.panel.metric)
    error.value = ''
    if (r.unit) unit.value = r.unit
    if (r.value == null) {
      error.value = 'No value reported.'
      return
    }
    const t = new Date(r.ts).getTime()
    const arr = seriesPoints.value[key] || []
    const lastT = arr.length ? arr[arr.length - 1][0] : -1
    const next = { ...seriesPoints.value }
    const value = applyExpr(mathFn.value, r.value)
    if (t > lastT) next[key] = trimWindow([...arr, [t, value]])
    seriesPoints.value = next
    seriesLatest.value = { ...seriesLatest.value, [key]: { value, ts: r.ts } }
    emit('updated', t)
  } catch (e) {
    if (e?.response?.status === 404) error.value = 'No readings yet for this connection.'
    else error.value = e?.message || 'Failed to fetch latest reading.'
  }
}

function startTimer() {
  if (timer) clearInterval(timer)
  timer = setInterval(poll, pollSeconds.value * 1000)
}

// Restart the timer whenever the panel's interval changes (admin edit).
watch(pollSeconds, startTimer)

// Re-seed when the panel's data binding changes (admin edits tags/metric/window).
watch(
  () => JSON.stringify([
    props.panel.source, props.panel.device_id, props.panel.metric,
    rangeMinutes.value, seriesTags.value,
    props.panel.table_name, props.panel.filter_col, props.panel.ts_col,
    props.panel.datasource_id,
  ]),
  async () => {
    await seed()
    startTimer()
  },
)

// Live page's Refresh button bumps refreshSignal → re-fetch this tile now.
watch(() => props.refreshSignal, () => { seed() })

onMounted(async () => {
  if (showFilterChanger.value) {
    availableFilters.value = await fetchSchemaValues(
      props.panel.table_name, props.panel.filter_col, 500, props.panel.datasource_id || undefined,
    ).catch(() => [])
  }
  await seed()
  startTimer()
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <div class="panel__titlewrap">
        <span
          v-if="editMode && canManage"
          class="panel__drag"
          title="Drag to move"
          aria-label="Drag to move panel"
        >⠿</span>
        <h3 class="panel__title">{{ panel.title }}</h3>
      </div>
      <div class="panel__actions">
        <el-popover
          v-model:visible="gearOpen"
          trigger="click"
          placement="bottom-end"
          width="200"
          :show-arrow="false"
          popper-class="panel-gear-pop"
        >
          <template #reference>
            <button
              type="button"
              class="panel__gear"
              :class="{ 'panel__gear--active': gearOpen }"
              title="Panel settings"
              aria-label="Panel settings"
            >
              <el-icon><Setting /></el-icon>
            </button>
          </template>

          <div class="gearpop">
            <div v-if="showFilterChanger" class="gearpop__row">
              <span class="gearpop__label">Series value</span>
              <el-select
                :model-value="effectiveFilters[0]"
                size="small"
                filterable
                class="gearpop__control"
                @update:model-value="onFilterValueSelect"
              >
                <el-option v-for="v in availableFilters" :key="v" :label="v" :value="v" />
              </el-select>
            </div>

            <div class="gearpop__row">
              <span class="gearpop__label">Time range</span>
              <el-select
                :model-value="rangeMinutes"
                size="small"
                class="gearpop__control"
                @update:model-value="onRangeSelect"
              >
                <el-option v-for="it in TIME_RANGES" :key="it.value" :label="it.label" :value="it.value" />
              </el-select>
            </div>

            <div class="gearpop__row">
              <span class="gearpop__label">Poll interval</span>
              <el-select
                :model-value="pollSeconds"
                size="small"
                class="gearpop__control"
                :disabled="!canChangePollInterval"
                :title="canChangePollInterval ? '' : 'Operator or admin only'"
                @update:model-value="onPollIntervalSelect"
              >
                <el-option v-for="it in POLL_INTERVALS" :key="it.value" :label="it.label" :value="it.value" />
              </el-select>
            </div>

            <template v-if="canManage">
              <div class="gearpop__divider" />
              <button type="button" class="gearpop__action" @click="gearOpen = false; emit('edit', panel)">
                <el-icon><Edit /></el-icon> Edit panel
              </button>
              <button type="button" class="gearpop__action" @click="gearOpen = false; emit('duplicate', panel)">
                <el-icon><CopyDocument /></el-icon> Duplicate
              </button>
              <button type="button" class="gearpop__action gearpop__action--danger" @click="gearOpen = false; emit('delete', panel)">
                <el-icon><Close /></el-icon> Delete
              </button>
            </template>
          </div>
        </el-popover>
      </div>
    </header>

    <span class="panel__conn">
      <template v-if="isTable">
        {{ panel.table_name }}<template v-if="tableHasFilter"> · {{ effectiveFilters.join(', ') }}</template> · {{ tableValueCols.join(', ') }}
      </template>
      <template v-else-if="isTag">tag · {{ seriesTags.join(', ') }} · {{ panel.metric }}</template>
      <template v-else>{{ deviceName || `device #${panel.device_id}` }} · {{ panel.metric }}</template>
    </span>

    <div class="panel__meta">
      <template v-if="showHeaderValue">
        <!-- Multi-series: coloured tag chips instead of a single big number. -->
        <template v-if="isMulti">
          <span v-for="(s, i) in seriesList" :key="s.key" class="panel__chip">
            <span class="panel__chipdot" :style="{ background: colorAt(i) }" />
            {{ s.label }}: {{ s.latest ? fmt(s.latest.value) : '—' }}{{ s.unit ? ' ' + s.unit : '' }}
          </span>
        </template>
        <template v-else>
          <span class="panel__num">{{ firstLatest ? fmt(firstLatest.value) : '—' }}</span>
          <span class="panel__unit">{{ headerUnit }}</span>
        </template>
      </template>
    </div>

    <p v-if="error" class="panel__error">{{ error }}</p>

    <!-- Alert pill: shown above the chart when any condition is true. -->
    <div v-if="alertSeries.length" class="panel__alert" role="status">
      {{ alertSeries.join(', ') }} ALERTS
    </div>

    <!-- Stat: big number(s) + optional sparkline (single tag only) -->
    <div v-if="vizType === 'stat'" class="panel__stat" :class="{ 'panel__stat--multi': isMulti }">
      <div v-for="(s, i) in seriesList" :key="s.key" class="panel__statrow">
        <div class="panel__statnum" :style="{ color: s.latest ? thColor(s.latest.value, colorAt(i)) : 'var(--fg)' }">
          {{ s.latest ? fmt(s.latest.value) : '—' }}<span class="panel__statunit">{{ s.unit }}</span>
        </div>
        <span v-if="isMulti" class="panel__statlabel" :style="{ color: colorAt(i) }">{{ s.label }}</span>
        <VChart v-if="opts.sparkline !== false && !isMulti" class="panel__spark" :option="sparklineOptionFor(s, i)" autoresize />
      </div>
    </div>

    <!-- Table: recent readings, one value column per series -->
    <div v-else-if="vizType === 'table'" class="panel__tablewrap">
      <table class="panel__table">
        <thead>
          <tr>
            <th>Time</th>
            <th v-for="(s, i) in seriesList" :key="s.key" :style="{ color: isMulti ? colorAt(i) : undefined }">
              {{ s.label }}{{ s.unit ? ' (' + s.unit + ')' : '' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, k) in tableRows" :key="k">
            <td>{{ row.t }}</td>
            <td v-for="(c, ci) in row.cells" :key="ci">{{ c }}</td>
          </tr>
          <tr v-if="!tableRows.length"><td :colspan="seriesList.length + 1" class="panel__tableempty">No data</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Gauge: small multiples, one radial gauge per series -->
    <div v-else-if="vizType === 'gauge'" class="panel__minis" :class="{ 'panel__minis--multi': isMulti }">
      <div v-for="(s, i) in seriesList" :key="s.key" class="panel__minicell">
        <VChart class="panel__minichart" :class="{ 'panel__minichart--multi': isMulti }" :option="gaugeOptionFor(s, i)" autoresize />
        <span v-if="isMulti" class="panel__minilabel" :style="{ color: colorAt(i) }">{{ s.label }}</span>
      </div>
    </div>

    <!-- Time series / bar / histogram / bar gauge / pie / heatmap / scatter / state timeline / candlestick -->
    <VChart v-else-if="isGeneric" class="panel__chart" :style="chartStyle" :option="option" autoresize />
  </article>
</template>

<style scoped>
/* ---------------------------------------------------------------------------
 * Liquid Crystal faceplate
 * A translucent, frosted glass tile over the dark app background. The body is
 * a layered surface (iridescent accent bloom + top-down glass sheen + frosted
 * base) and the signature is a specular rim-light: a masked gradient border
 * that's bright along the top facet and fades by mid-panel, like light caught
 * on the edge of a crystal. All colours derive from theme tokens so the look
 * survives faceplate swaps (cobalt / graphite / carbon).
 * ------------------------------------------------------------------------- */
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* Frosted base + glass sheen + accent bloom, painted behind all content. */
  background:
    radial-gradient(130% 90% at 100% -10%, var(--accent-soft), transparent 55%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 32%),
    color-mix(in srgb, var(--bg-panel) 68%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(165%);
  backdrop-filter: blur(16px) saturate(165%);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  /* Fill the GridLayout cell so corner-resize is reflected immediately. */
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 8px 30px rgba(0, 0, 0, 0.45),
    0 2px 8px rgba(0, 0, 0, 0.3);
  transition: box-shadow 0.3s ease, transform 0.3s ease;
}

/* Signature: specular rim-light. A masked 1px gradient border, bright at the
   top facet and fading to nothing by the panel's midpoint. */
.panel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.55),
    rgba(255, 255, 255, 0.08) 18%,
    rgba(255, 255, 255, 0) 46%
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

.panel:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 14px 44px rgba(0, 0, 0, 0.5),
    0 12px 48px -16px var(--accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  .panel {
    transition: none;
  }
  .panel:hover {
    transform: none;
  }
}

.panel__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
}

.panel__titlewrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

/* Drag grip — only this element starts a GridLayout drag (drag-allow-from). */
.panel__drag {
  align-self: flex-start;
  cursor: move;
  user-select: none;
  font-size: 14px;
  line-height: 1;
  color: var(--fg-muted);
  padding: 2px 4px;
  margin-bottom: 2px;
  border-radius: 4px;
}

.panel__drag:hover {
  color: var(--fg);
  background: var(--border-soft);
}

.panel__conn {
  font-size: 12px;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
  word-break: normal;
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

/* Gear trigger — collapses series value / time range / poll interval / admin
   actions into one control so the header stays calm as features are added. */
.panel__gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.panel__gear:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* Open state borrows the faceplate's lit-LCD glow so the trigger itself
   reads as "live" while its controls are exposed. */
.panel__gear--active {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.gearpop {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.gearpop__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gearpop__label {
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.gearpop__control {
  width: 100%;
}

.gearpop__divider {
  height: 1px;
  background: var(--border-soft);
  margin: 2px 0;
}

.gearpop__action {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: 13px;
  font-family: var(--font-sans);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.gearpop__action:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.gearpop__action--danger:hover {
  background: rgba(239, 68, 68, 0.12);
  color: var(--crit);
}

/* Popper content is teleported but stays in this component's render tree, so
   scoped styles still apply — reached via :deep() since Element Plus, not
   this template, owns the wrapping .panel-gear-pop element. Mirrors the
   faceplate's frosted-glass treatment so the popover reads as a facet of the
   panel rather than a generic dropdown. */
:deep(.panel-gear-pop) {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 32%),
    color-mix(in srgb, var(--bg-elev) 88%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(165%);
  backdrop-filter: blur(16px) saturate(165%);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 8px 30px rgba(0, 0, 0, 0.45);
  padding: var(--space-3);
}

.panel__meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.panel__num {
  font-size: 24px;
  font-weight: 700;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  /* Lit-LCD halo — a faint accent bloom behind the live readout. */
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 35%, transparent);
}

.panel__unit {
  font-size: 13px;
  color: var(--fg-muted);
}

.panel__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  /* Glass pill so multi-series chips read as frosted crystal tokens. */
  padding: 2px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-elev) 55%, transparent);
  border: 1px solid var(--border-soft);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.panel__chipdot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.panel__error {
  color: #f5a524;
  margin: 0;
  font-size: 12px;
}

/* Alert pill — a red frosted token, modeled on .panel__chip, surfacing a
   true alert condition above the chart. Uses the crit red (#f56c6c). */
.panel__alert {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #ffd7d7;
  padding: 3px 11px;
  border-radius: 999px;
  background: color-mix(in srgb, #f56c6c 22%, transparent);
  border: 1px solid color-mix(in srgb, #f56c6c 70%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  box-shadow: 0 0 14px color-mix(in srgb, #f56c6c 30%, transparent);
}

.panel__chart {
  width: 100%;
  height: 220px;
  /* Grow to fill the GridLayout cell; ECharts (autoresize) redraws to fit. */
  flex: 1 1 auto;
  min-height: 180px;
}

/* Gauge small multiples */
.panel__minis {
  display: flex;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-height: 0;
}

.panel__minis--multi {
  flex-wrap: wrap;
}

.panel__minicell {
  flex: 1 1 0;
  min-width: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.panel__minichart {
  width: 100%;
  height: 220px;
}

.panel__minichart--multi {
  height: 150px;
}

.panel__minilabel {
  font-size: 11px;
  margin-top: 0px;
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Stat */
.panel__stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 120px;
}

.panel__stat--multi {
  min-height: 0;
  gap: var(--space-1);
}

.panel__statrow {
  display: flex;
  flex-direction: column;
}

.panel__statnum {
  font-size: 46px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  letter-spacing: 0.01em;
  /* Lit-LCD halo, tinted by the segment's own threshold colour. */
  text-shadow: 0 0 26px color-mix(in srgb, currentColor 30%, transparent);
}

.panel__stat--multi .panel__statnum {
  font-size: 26px;
}

.panel__statunit {
  font-size: 18px;
  color: var(--fg-muted);
  margin-left: 6px;
}

.panel__stat--multi .panel__statunit {
  font-size: 13px;
}

.panel__statlabel {
  font-size: 12px;
}

.panel__spark {
  width: 100%;
  height: 64px;
}

/* Table */
.panel__tablewrap {
  max-height: 240px;
  overflow-y: auto;
}

.panel__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.panel__table th {
  text-align: left;
  color: var(--fg-muted);
  font-weight: 500;
  padding: 6px 8px;
  position: sticky;
  top: 0;
  /* Near-opaque so scrolled rows don't bleed through the frosted faceplate. */
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-soft);
}

.panel__table td {
  padding: 5px 8px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--border-soft);
}

.panel__tableempty {
  color: var(--fg-muted);
  text-align: center;
}
</style>
