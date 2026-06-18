<script setup>
/**
 * LivePanel — a single self-polling tile in the Live dashboard grid.
 *
 * Renders one device+metric "connection" in a configurable Grafana-style
 * visualization: time series, bar, stat, gauge, bar gauge, histogram or table.
 * The per-viz parameters (min/max, thresholds, decimals, orientation, …) come
 * from `panel.options`. Streams a sliding-window series from /api/readings,
 * refreshing every POLL_MS. Admins see Edit / Delete controls in the header.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, GaugeChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { fetchSeries, fetchLatest } from '@/api/readings'
import { fetchTagLatest } from '@/api/tags'

use([CanvasRenderer, LineChart, BarChart, GaugeChart, GridComponent, TooltipComponent])

const ACCENT = '#4f8cff'
const WARN_COLOR = '#e6a23c'
const CRIT_COLOR = '#f56c6c'

const props = defineProps({
  panel: { type: Object, required: true },
  deviceName: { type: String, default: '' },
  canManage: { type: Boolean, default: false },
})

const emit = defineEmits(['edit', 'delete', 'poll-interval-change'])

// Poll interval selector — values are seconds, kept in sync with backend whitelist.
const POLL_INTERVALS = [
  { value: 5, label: '5s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
]

const pollSeconds = computed(() => props.panel.poll_interval_seconds || 5)
const isTag = computed(() => props.panel.source === 'tag')

function onPollIntervalSelect(v) {
  emit('poll-interval-change', props.panel, v)
}

const points = ref([]) // [[epochMs, value], ...]
const latest = ref(null) // { value, ts }
const unit = ref('')
const error = ref('')

let timer = null

// Normalize legacy "line" panels to the time-series renderer.
const vizType = computed(() => (props.panel.chart_type === 'line' ? 'timeseries' : props.panel.chart_type))
const opts = computed(() => props.panel.options || {})

const isChart = computed(() => !['stat', 'table'].includes(vizType.value))
const showHeaderValue = computed(() => ['timeseries', 'bar', 'histogram'].includes(vizType.value))

const lastUpdated = computed(() =>
  latest.value ? new Date(latest.value.ts).toLocaleTimeString() : '—',
)

function fmt(v) {
  if (v == null) return '—'
  const d = opts.value.decimals
  return d == null ? `${v}` : Number(v).toFixed(d)
}

// Threshold → colour. warn/crit are "value ≥" cut-offs.
function thColor(v) {
  const { warn, crit } = opts.value
  if (crit != null && v >= crit) return CRIT_COLOR
  if (warn != null && v >= warn) return WARN_COLOR
  return ACCENT
}

const latestValue = computed(() => (latest.value ? latest.value.value : null))

// --- Per-type ECharts option ----------------------------------------------
function timeseriesOption() {
  return {
    grid: { top: 12, right: 14, bottom: 26, left: 46 },
    tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' }, valueFormatter: (v) => `${fmt(v)} ${unit.value}` },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLine: { show: false }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
    series: [{
      name: props.panel.metric, type: 'line',
      smooth: opts.value.smooth !== false,
      showSymbol: false,
      lineStyle: { width: opts.value.lineWidth || 2, color: ACCENT },
      areaStyle: opts.value.area === false ? undefined : { opacity: 0.1, color: ACCENT },
      data: points.value,
    }],
  }
}

function barOption() {
  return {
    grid: { top: 12, right: 14, bottom: 26, left: 46 },
    tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' }, valueFormatter: (v) => `${fmt(v)} ${unit.value}` },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLine: { show: false }, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
    series: [{ name: props.panel.metric, type: 'bar', itemStyle: { color: ACCENT, borderRadius: [2, 2, 0, 0] }, data: points.value }],
  }
}

function gaugeOption() {
  const min = Number(opts.value.min ?? 0)
  const max = Number(opts.value.max ?? 100)
  const span = max - min || 1
  const { warn, crit } = opts.value
  // Build coloured axis segments from the thresholds.
  const stops = []
  if (warn != null) stops.push([(warn - min) / span, ACCENT])
  if (crit != null) stops.push([(crit - min) / span, warn != null ? WARN_COLOR : ACCENT])
  stops.push([1, crit != null ? CRIT_COLOR : warn != null ? WARN_COLOR : ACCENT])
  return {
    series: [{
      type: 'gauge', min, max, radius: '92%', center: ['50%', '58%'],
      axisLine: { lineStyle: { width: 10, color: stops } },
      progress: { show: false },
      pointer: { width: 4, itemStyle: { color: thColor(latestValue.value ?? min) } },
      axisTick: { show: false },
      splitLine: { length: 10, lineStyle: { color: 'rgba(255,255,255,0.25)' } },
      axisLabel: { color: '#8a99b3', fontSize: 9, distance: 12 },
      anchor: { show: true, size: 8, itemStyle: { color: thColor(latestValue.value ?? min) } },
      detail: { valueAnimation: true, formatter: (v) => `${fmt(v)} ${unit.value}`, color: '#e6edf7', fontSize: 18, offsetCenter: [0, '78%'] },
      data: [{ value: latestValue.value ?? min }],
    }],
  }
}

function barGaugeOption() {
  const min = Number(opts.value.min ?? 0)
  const max = Number(opts.value.max ?? 100)
  const v = latestValue.value ?? min
  const vertical = opts.value.orientation === 'vertical'
  const valueAxis = { type: 'value', min, max, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } }
  const catAxis = { type: 'category', data: [''], axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } }
  return {
    grid: { top: 16, bottom: 24, left: 16, right: 56, containLabel: true },
    tooltip: { backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } },
    xAxis: vertical ? catAxis : valueAxis,
    yAxis: vertical ? valueAxis : catAxis,
    series: [{
      type: 'bar', barWidth: '45%',
      itemStyle: { color: thColor(v), borderRadius: 4 },
      label: { show: true, position: vertical ? 'top' : 'right', color: '#e6edf7', fontSize: 13, formatter: () => `${fmt(v)} ${unit.value}` },
      data: [v],
    }],
  }
}

function histogramOption() {
  const vals = points.value.map((p) => p[1])
  const n = Math.max(2, Number(opts.value.buckets ?? 20))
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) {
    hi = (lo || 0) + 1
    lo = lo || 0
  }
  const width = (hi - lo) / n
  const counts = new Array(n).fill(0)
  for (const x of vals) {
    let i = Math.floor((x - lo) / width)
    if (i >= n) i = n - 1
    if (i < 0) i = 0
    counts[i] += 1
  }
  const labels = counts.map((_, i) => fmt(lo + i * width))
  return {
    grid: { top: 12, right: 14, bottom: 30, left: 40 },
    tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8a99b3', fontSize: 9, interval: Math.ceil(n / 8) }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
    series: [{ type: 'bar', itemStyle: { color: ACCENT, borderRadius: [2, 2, 0, 0] }, data: counts }],
  }
}

function sparklineOption() {
  return {
    grid: { top: 4, right: 4, bottom: 4, left: 4 },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', scale: true, show: false },
    series: [{ type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2, color: ACCENT }, areaStyle: { opacity: 0.15, color: ACCENT }, data: points.value }],
  }
}

const option = computed(() => {
  switch (vizType.value) {
    case 'bar': return barOption()
    case 'gauge': return gaugeOption()
    case 'bargauge': return barGaugeOption()
    case 'histogram': return histogramOption()
    default: return timeseriesOption()
  }
})

// --- Table rows ------------------------------------------------------------
const tableRows = computed(() => {
  const max = Math.max(1, Number(opts.value.maxRows ?? 10))
  return points.value
    .slice(-max)
    .reverse()
    .map(([t, v]) => ({ t: new Date(t).toLocaleTimeString(), v: fmt(v) }))
})

// --- Polling ---------------------------------------------------------------
function trimWindow() {
  const cutoff = Date.now() - props.panel.window_minutes * 60_000
  points.value = points.value.filter(([t]) => t >= cutoff)
}

async function seed() {
  if (isTag.value) {
    // status_tag has no native history — start empty, accumulate via polling.
    points.value = []
    latest.value = null
    unit.value = ''
    await poll()
    return
  }
  try {
    const res = await fetchSeries(props.panel.device_id, props.panel.metric, props.panel.window_minutes)
    unit.value = res.unit || ''
    points.value = res.points.map((p) => [new Date(p.ts).getTime(), p.value])
    if (points.value.length) {
      const last = res.points[res.points.length - 1]
      latest.value = { value: last.value, ts: last.ts }
    } else {
      latest.value = null
    }
    error.value = ''
  } catch (e) {
    error.value = e?.message || 'Failed to load series.'
  }
}

async function poll() {
  try {
    let value, tsIso, u
    if (isTag.value) {
      const r = await fetchTagLatest(props.panel.tag_name)
      value = r[props.panel.metric]
      tsIso = r.ts || new Date().toISOString()
      u = ''
    } else {
      const r = await fetchLatest(props.panel.device_id, props.panel.metric)
      value = r.value
      tsIso = r.ts
      u = r.unit || unit.value
    }
    error.value = ''
    if (u) unit.value = u
    if (value == null) {
      error.value = 'No value reported.'
      return
    }
    const t = new Date(tsIso).getTime()
    const lastT = points.value.length ? points.value[points.value.length - 1][0] : -1
    if (t > lastT) {
      points.value = [...points.value, [t, value]]
      trimWindow()
    }
    latest.value = { value, ts: tsIso }
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

onMounted(async () => {
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
        <h3 class="panel__title">{{ panel.title }}</h3>
        <span class="panel__conn">
          <template v-if="isTag">tag · {{ panel.tag_name }} · {{ panel.metric }}</template>
          <template v-else>{{ deviceName || `device #${panel.device_id}` }} · {{ panel.metric }}</template>
        </span>
      </div>
      <div class="panel__actions">
        <el-select
          :model-value="pollSeconds"
          size="small"
          class="panel__poll"
          :disabled="!canManage"
          :title="canManage ? 'Poll interval' : 'Poll interval (admin only)'"
          @update:model-value="onPollIntervalSelect"
        >
          <el-option v-for="it in POLL_INTERVALS" :key="it.value" :label="it.label" :value="it.value" />
        </el-select>
        <template v-if="canManage">
          <el-button size="small" text @click="emit('edit', panel)">Edit</el-button>
          <el-button size="small" text type="danger" @click="emit('delete', panel)">Delete</el-button>
        </template>
      </div>
    </header>

    <div class="panel__meta">
      <template v-if="showHeaderValue">
        <span class="panel__num">{{ latest ? fmt(latest.value) : '—' }}</span>
        <span class="panel__unit">{{ unit }}</span>
      </template>
      <span class="panel__updated">Updated {{ lastUpdated }}</span>
    </div>

    <p v-if="error" class="panel__error">{{ error }}</p>

    <!-- Stat: big number + optional sparkline -->
    <div v-if="vizType === 'stat'" class="panel__stat">
      <div class="panel__statnum" :style="{ color: latest ? thColor(latest.value) : 'var(--fg)' }">
        {{ latest ? fmt(latest.value) : '—' }}<span class="panel__statunit">{{ unit }}</span>
      </div>
      <VChart v-if="opts.sparkline !== false" class="panel__spark" :option="sparklineOption()" autoresize />
    </div>

    <!-- Table: recent readings -->
    <div v-else-if="vizType === 'table'" class="panel__tablewrap">
      <table class="panel__table">
        <thead>
          <tr><th>Time</th><th>{{ panel.metric }} ({{ unit }})</th></tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in tableRows" :key="i">
            <td>{{ row.t }}</td>
            <td>{{ row.v }}</td>
          </tr>
          <tr v-if="!tableRows.length"><td colspan="2" class="panel__tableempty">No data</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Everything else: an ECharts chart -->
    <VChart v-else-if="isChart" class="panel__chart" :option="option" autoresize />
  </article>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: var(--space-4);
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
  min-width: 0;
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.panel__conn {
  font-size: 12px;
  color: var(--fg-muted);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.panel__poll {
  width: 78px;
}

.panel__meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.panel__num {
  font-size: 24px;
  font-weight: 700;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.panel__unit {
  font-size: 13px;
  color: var(--fg-muted);
}

.panel__updated {
  margin-left: auto;
  font-size: 12px;
  color: var(--fg-muted);
  opacity: 0.8;
}

.panel__error {
  color: #f5a524;
  margin: 0;
  font-size: 12px;
}

.panel__chart {
  width: 100%;
  height: 220px;
}

/* Stat */
.panel__stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 120px;
}

.panel__statnum {
  font-size: 46px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.panel__statunit {
  font-size: 18px;
  color: var(--fg-muted);
  margin-left: 6px;
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
  background: var(--bg-panel);
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
