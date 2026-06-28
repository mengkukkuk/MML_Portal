<script setup>
/**
 * LivePage — admin-managed live dashboard (route: /live).
 *
 * Renders a grid of LivePanel tiles, one per machine/metric "panel" stored in
 * the backend (dashboard_panels). Each tile self-polls /api/readings every 5s.
 * Admins can Add / Edit / Delete panels, re-point each panel's connection
 * (device + metric), pick a Grafana-style visualization type and tune that
 * type's parameters via a sub-menu. Operators get a read-only grid.
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { GridLayout, GridItem } from 'grid-layout-plus'
import { useAuthStore } from '@/stores/auth'
import LivePanel from '@/components/LivePanel.vue'
import { fetchDevices } from '@/api/readings'
import { fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues } from '@/api/schema'
import { fetchPanels, createPanel, updatePanel, deletePanel } from '@/api/panels'
import { fetchDashboards, createDashboard, updateDashboard, deleteDashboard } from '@/api/dashboards'
import { fetchDatasources } from '@/api/datasources'
import { colorAt } from '@/utils/seriesPalette'
import { compileExpr } from '@/utils/mathExpr'
import { UNIT_GROUPS } from '@/utils/units'

// Legacy tag API field names → real status_tag column names, so editing an old
// tag panel maps cleanly onto the generic table model.
const TAG_FIELD_TO_COL = { current_value: 'current_value_tag' }

// Poll-interval choices shown in the editor & on each panel header.
// Values are seconds and must match the backend whitelist in panels.py.
const POLL_INTERVALS = [
  { value: 5, label: '5 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
]

const auth = useAuthStore()
const canManage = computed(() => auth.role === 'admin')
const route = useRoute()
const router = useRouter()

// --- Visualization catalogue (mirrors LivePanel's renderers) ---------------
const VIZ_TYPES = [
  { value: 'timeseries', label: 'Time series', icon: 'TrendCharts', hint: 'Time based line & area charts' },
  { value: 'bar', label: 'Bar chart', icon: 'Histogram', hint: 'Value bars over time' },
  { value: 'stat', label: 'Stat', icon: 'Odometer', hint: 'Big value & sparkline' },
  { value: 'gauge', label: 'Gauge', icon: 'Compass', hint: 'Radial gauge with thresholds' },
  { value: 'bargauge', label: 'Bar gauge', icon: 'Sort', hint: 'Horizontal / vertical level bar' },
  { value: 'histogram', label: 'Histogram', icon: 'DataAnalysis', hint: 'Distribution of values' },
  { value: 'table', label: 'Table', icon: 'Grid', hint: 'Recent readings table' },
  { value: 'pie', label: 'Pie / Donut', icon: 'PieChart', hint: 'Proportional breakdown of series values' },
  { value: 'heatmap', label: 'Heatmap', icon: 'Operation', hint: 'Value intensity across time × series' },
  { value: 'scatter', label: 'Scatter', icon: 'Aim', hint: 'Individual data points over time' },
  { value: 'statetimeline', label: 'State timeline', icon: 'Calendar', hint: 'Discrete state bands over time (ON/OFF, OPEN/CLOSED)' },
  { value: 'candlestick', label: 'Candlestick', icon: 'Coin', hint: 'Min / open / close / max per interval' },
]

// Per-type parameter schema rendered in the editor sub-menu.
// field types: 'switch' | 'number' | 'enum'
const PARAM_SCHEMA = {
  timeseries: [
    { key: 'smooth', label: 'Smooth line', type: 'switch', default: true },
    { key: 'area', label: 'Fill area', type: 'switch', default: true },
    { key: 'lineWidth', label: 'Line width', type: 'number', default: 2, min: 1, max: 6 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  bar: [
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  stat: [
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
    { key: 'sparkline', label: 'Show sparkline', type: 'switch', default: true },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  gauge: [
    { key: 'min', label: 'Min', type: 'number', default: 0 },
    { key: 'max', label: 'Max', type: 'number', default: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  bargauge: [
    { key: 'min', label: 'Min', type: 'number', default: 0 },
    { key: 'max', label: 'Max', type: 'number', default: 100 },
    { key: 'orientation', label: 'Orientation', type: 'enum', options: ['horizontal', 'vertical'], default: 'horizontal' },
    { key: 'warn', label: 'Warning ≥', type: 'number', default: null, nullable: true },
    { key: 'crit', label: 'Critical ≥', type: 'number', default: null, nullable: true },
  ],
  histogram: [
    { key: 'buckets', label: 'Buckets', type: 'number', default: 20, min: 2, max: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  table: [
    { key: 'maxRows', label: 'Max rows', type: 'number', default: 10, min: 1, max: 100 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  pie: [
    { key: 'donut', label: 'Donut style', type: 'switch', default: true },
    { key: 'innerRadius', label: 'Inner radius %', type: 'number', default: 50, min: 10, max: 80 },
    { key: 'labelPosition', label: 'Labels', type: 'enum', options: ['outside', 'inside', 'none'], default: 'outside' },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  heatmap: [
    { key: 'bucketMinutes', label: 'Bucket (min)', type: 'number', default: 5, min: 1, max: 60 },
    { key: 'colorMin', label: 'Color min', type: 'number', default: null, nullable: true },
    { key: 'colorMax', label: 'Color max', type: 'number', default: null, nullable: true },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  scatter: [
    { key: 'pointSize', label: 'Point size', type: 'number', default: 6, min: 2, max: 20 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
  statetimeline: [
    { key: 'roundValues', label: 'Round to integer', type: 'switch', default: true },
  ],
  candlestick: [
    { key: 'bucketMinutes', label: 'Bucket (min)', type: 'number', default: 5, min: 1, max: 60 },
    { key: 'decimals', label: 'Decimals', type: 'number', default: 1, min: 0, max: 4 },
  ],
}

function defaultOptions(type) {
  const out = {}
  for (const f of PARAM_SCHEMA[type] || []) out[f.key] = f.default
  return out
}

const dashboards = ref([])              // [{ id, title, position, created_at }]
const activeDashboardId = ref(null)
const switching = ref(false)            // true while loading a dashboard's panels
const panels = ref([])
const editMode = ref(false)
const savingLayout = ref(false)
// Grid layout array bound to GridLayout (v-model:layout). Items: {i,x,y,w,h}.
const layout = ref([])
const devices = ref([])
const schemaTables = ref([])   // [{ table, label }]
const schemaCols = ref({ value_columns: [], ts_columns: [], filter_columns: [] })
const filterValues = ref([])   // distinct values of the chosen filter column
const schemaColsCache = new Map()  // table_name → columns (avoids redundant fetches)
const loading = ref(true)
const error = ref('')

// --- Editor dialog state ---------------------------------------------------
const dialogVisible = ref(false)
const editingId = ref(null) // null = create mode
const saving = ref(false)
// Saved connections an admin can bind a panel to. The selection is persisted on
// the panel (datasource_id); query routing to the external DB is a follow-up.
const datasources = ref([])
const form = reactive({
  title: '',
  datasource_id: null, // null = the app database (default)
  table_name: null,
  // Primary value column (kept here for back-compat); extras append to value_cols.
  // The renderer plots one series per (value × filter) combination.
  metric: null,
  value_cols: [],    // additional value columns (each becomes its own series)
  units: {},         // value-column name → display unit suffix (e.g. { value_tag: 'bar' })
  filter_col: null,  // optional series-key column
  filters: [],       // chosen filter values, each its own series/color
  ts_col: null,      // optional timestamp column (enables real history)
  // Optional math transform applied to every reading before display.
  // Kept outside form.options because onVizTypeChange replaces options wholesale.
  mathExpr: '',
  window_minutes: 15,
  chart_type: 'timeseries',
  options: defaultOptions('timeseries'),
  poll_interval_seconds: 5,
})

// All currently-selected value columns (primary first, then extras), used both
// as the source of truth for the editor's value rows and for "unused" lookups.
const allValueCols = computed(() => [form.metric, ...form.value_cols].filter(Boolean))

// First value column not already chosen, so [+ Value] defaults to a fresh pick.
function firstUnusedValueCol() {
  const used = new Set(allValueCols.value)
  const pool = schemaCols.value.value_columns || []
  return pool.find((c) => !used.has(c)) ?? null
}

function addValueCol() {
  const c = firstUnusedValueCol()
  if (c) form.value_cols.push(c)
}

function removeValueCol(i) {
  const col = form.value_cols[i]
  form.value_cols.splice(i, 1)
  if (col && !allValueCols.value.includes(col)) delete form.units[col]
}

// Declare (or clear) the display unit for a series. Keyed by the series-
// distinguishing value (filter value when filtered, else value column) so it
// rides into options.units on save.
function setUnit(key, val) {
  if (!key) return
  if (val) form.units[key] = val
  else delete form.units[key]
}

// First filter value not already chosen, so [+ Add series] picks something fresh.
function firstUnusedFilter() {
  const used = new Set(form.filters)
  return filterValues.value.find((v) => !used.has(v)) ?? filterValues.value[0] ?? null
}

function addFilter() {
  const v = firstUnusedFilter()
  if (v != null) form.filters.push(v)
}

function removeFilter(i) {
  const fv = form.filters[i]
  form.filters.splice(i, 1)
  if (fv != null && !form.filters.includes(fv)) delete form.units[fv]
}

const dialogTitle = computed(() => (editingId.value ? 'Edit panel' : 'Add panel'))
const currentSchema = computed(() => PARAM_SCHEMA[form.chart_type] || [])

const deviceName = (id) => devices.value.find((d) => d.id === id)?.name || ''

// Switching viz type resets its parameters to that type's defaults.
function onVizTypeChange(type) {
  form.options = defaultOptions(type)
}

// Load the distinct values for the current filter column into filterValues.
async function loadFilterValues() {
  if (!form.table_name || !form.filter_col) {
    filterValues.value = []
    return
  }
  try {
    filterValues.value = await fetchSchemaValues(form.table_name, form.filter_col)
  } catch {
    filterValues.value = []
  }
}

// Resolve a binding against the chosen table's columns, clamping each field to a
// valid value. Shared by openCreate / openEdit and the table-change handler.
async function applyBinding({ table, metric, value_cols, filter_col, filters, ts_col }) {
  // Fall back to the first available table if the requested one isn't selectable.
  const exists = schemaTables.value.some((t) => t.table === table)
  form.table_name = exists ? table : (schemaTables.value[0]?.table ?? null)
  if (!form.table_name) {
    schemaCols.value = { value_columns: [], ts_columns: [], filter_columns: [] }
    form.metric = null; form.value_cols = []
    form.filter_col = null; form.filters = []; form.ts_col = null
    filterValues.value = []
    return
  }
  try {
    if (!schemaColsCache.has(form.table_name)) {
      schemaColsCache.set(form.table_name, await fetchSchemaColumns(form.table_name))
    }
    schemaCols.value = schemaColsCache.get(form.table_name)
  } catch {
    schemaCols.value = { value_columns: [], ts_columns: [], filter_columns: [] }
  }
  const cols = schemaCols.value
  form.metric = cols.value_columns.includes(metric) ? metric : (cols.value_columns[0] ?? null)
  // Keep only extras that still exist in this table and aren't the primary.
  form.value_cols = (value_cols || [])
    .filter((c) => cols.value_columns.includes(c) && c !== form.metric)
  form.ts_col = ts_col && cols.ts_columns.includes(ts_col)
    ? ts_col
    : (cols.ts_columns[0] ?? null)
  form.filter_col = filter_col && cols.filter_columns.includes(filter_col) ? filter_col : null
  await loadFilterValues()
  if (form.filter_col) {
    const keep = (filters || []).filter((v) => filterValues.value.includes(v))
    form.filters = keep.length ? keep : (filterValues.value[0] != null ? [filterValues.value[0]] : [])
  } else {
    form.filters = []
  }
  // Drop unit declarations whose series no longer exist. Units key by filter
  // value (when filtered) or value column (when not) — keep both so editing
  // across modes doesn't lose data; save() does the final mode-specific prune.
  const liveKeys = new Set([form.metric, ...form.value_cols, ...form.filters].filter(Boolean))
  for (const k of Object.keys(form.units)) if (!liveKeys.has(k)) delete form.units[k]
}

async function onTableChange(table) {
  // New table → reset to its first value column, prefer a timestamp, no filter.
  await applyBinding({ table, metric: null, filter_col: null, filters: [], ts_col: null })
}

async function onFilterColChange(col) {
  form.filter_col = col || null
  await loadFilterValues()
  form.filters = form.filter_col && filterValues.value[0] != null ? [filterValues.value[0]] : []
}

async function openCreate() {
  editingId.value = null
  form.title = ''
  form.datasource_id = null
  form.mathExpr = ''
  form.window_minutes = 15
  form.chart_type = 'timeseries'
  form.options = defaultOptions('timeseries')
  form.poll_interval_seconds = 5
  form.units = {}
  dialogVisible.value = true  // show immediately; dropdowns populate once schema resolves
  await applyBinding({
    table: schemaTables.value[0]?.table ?? null,
    metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null,
  })
}

// Best-effort map of a legacy tag/device panel onto the generic table model.
function legacyBinding(panel) {
  if (panel.source === 'tag') {
    return {
      table: 'status_tag',
      metric: TAG_FIELD_TO_COL[panel.metric] || panel.metric,
      filter_col: 'tag_name',
      filters: panel.options?.tags?.length ? [...panel.options.tags] : (panel.tag_name ? [panel.tag_name] : []),
      // status_tag updates one row in place; leave ts unset so the tile samples
      // at the poll clock (its prior behaviour) instead of degenerate history.
      ts_col: null,
    }
  }
  if (panel.source === 'device') {
    return { table: 'sensor_readings', metric: 'value', filter_col: 'metric', filters: panel.metric ? [panel.metric] : [], ts_col: 'ts' }
  }
  return null
}

async function openEdit(panel) {
  editingId.value = panel.id
  form.title = panel.title
  form.datasource_id = panel.datasource_id ?? null
  form.chart_type = panel.chart_type === 'line' ? 'timeseries' : panel.chart_type
  // `filters`/`tags` and `mathExpr` live outside form.options — onVizTypeChange
  // replaces form.options wholesale and would otherwise drop them.
  const { tags: _t, filters: _f, value_cols: _v, mathExpr: _m, units: _u, ...vizOpts } = panel.options || {}
  form.options = { ...defaultOptions(form.chart_type), ...vizOpts }
  form.mathExpr = panel.options?.mathExpr || ''
  form.units = { ...(panel.options?.units || {}) }
  form.window_minutes = panel.window_minutes
  form.poll_interval_seconds = panel.poll_interval_seconds || 5

  const binding = panel.source === 'table'
    ? {
        table: panel.table_name,
        metric: panel.metric,
        value_cols: Array.isArray(panel.options?.value_cols) ? [...panel.options.value_cols] : [],
        filter_col: panel.filter_col,
        filters: panel.options?.filters?.length ? [...panel.options.filters] : [],
        ts_col: panel.ts_col,
      }
    : (legacyBinding(panel) || { table: null, metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null })
  dialogVisible.value = true  // show immediately; dropdowns populate once schema resolves
  await applyBinding(binding)
}

async function save() {
  if (!form.title.trim()) {
    ElMessage.warning('Title is required.')
    return
  }
  if (!form.table_name || !form.metric) {
    ElMessage.warning('Pick a table and a value column.')
    return
  }
  if (form.filter_col && !form.filters.length) {
    ElMessage.warning('Add at least one series value, or clear the filter column.')
    return
  }
  const compiled = compileExpr(form.mathExpr)
  if (!compiled.ok) {
    ElMessage.error(`Expression: ${compiled.error}`)
    return
  }
  saving.value = true
  try {
    const trimmedExpr = form.mathExpr?.trim() || ''
    const extraOpts = trimmedExpr ? { mathExpr: trimmedExpr } : {}
    // Per-series display units: keyed by filter value when filtered, else by
    // value column. Pruned to the active keys so stale cross-mode keys don't ride.
    const unitKeys = form.filter_col ? form.filters : allValueCols.value
    const unitMap = {}
    for (const k of unitKeys) if (form.units[k]) unitMap[k] = form.units[k]
    // Preserve the panel's layout when editing; seed a bottom slot when creating.
    const existing = editingId.value
      ? panels.value.find((p) => p.id === editingId.value)
      : null
    const layoutOpt = editingId.value
      ? (existing?.options?.layout ? { layout: existing.options.layout } : {})
      : { layout: nextLayoutSlot() }
    const payload = {
      title: form.title.trim(),
      source: 'table',
      device_id: null,
      tag_name: null,
      datasource_id: form.datasource_id || null,
      table_name: form.table_name,
      metric: form.metric,
      filter_col: form.filter_col || null,
      ts_col: form.ts_col || null,
      window_minutes: form.window_minutes,
      chart_type: form.chart_type,
      // Filter values ride in options.filters (parallel to the old options.tags).
      // Filter values + extra value columns ride in options (parallel to the
      // old options.tags). The primary value column stays in `metric`.
      options: {
        ...form.options,
        filters: [...form.filters],
        ...(form.value_cols.length ? { value_cols: [...form.value_cols] } : {}),
        ...(Object.keys(unitMap).length ? { units: unitMap } : {}),
        ...extraOpts,
        ...layoutOpt,
      },
      poll_interval_seconds: form.poll_interval_seconds,
      dashboard_id: activeDashboardId.value,
      position: editingId.value
        ? panels.value.find((p) => p.id === editingId.value)?.position ?? 0
        : panels.value.length,
    }
    if (editingId.value) {
      const updated = await updatePanel(editingId.value, payload)
      const i = panels.value.findIndex((p) => p.id === editingId.value)
      if (i !== -1) panels.value[i] = updated
      ElMessage.success('Panel updated.')
    } else {
      const created = await createPanel(payload)
      panels.value.push(created)
      appendLayoutItem(created)
      ElMessage.success('Panel added.')
    }
    dialogVisible.value = false
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to save panel.')
  } finally {
    saving.value = false
  }
}

// --- Duplicate-panel dialog (small centred form) --------------------------
const duplicateDialogVisible = ref(false)
const duplicating = ref(false)
const duplicateSource = ref(null)
const duplicateForm = reactive({ title: '' })

const deleteDialogVisible = ref(false)
const deleting = ref(false)
const deleteTarget = ref(null)

const lastUpdatedAt = ref(0)
const lastUpdatedLabel = computed(() =>
  lastUpdatedAt.value ? new Date(lastUpdatedAt.value).toLocaleTimeString() : '',
)
function onPanelUpdated(ts) {
  if (ts > lastUpdatedAt.value) lastUpdatedAt.value = ts
}

function duplicate(panel) {
  duplicateSource.value = panel
  duplicateForm.title = `${panel.title} (Copy)`
  duplicateDialogVisible.value = true
}

async function confirmDuplicate() {
  const panel = duplicateSource.value
  if (!panel) return
  const name = duplicateForm.title.trim()
  if (!name) {
    ElMessage.warning('Name is required.')
    return
  }
  duplicating.value = true
  try {
    const clonedOptions = JSON.parse(JSON.stringify(panel.options || {}))
    // Place the copy in a fresh bottom slot rather than overlapping the source.
    clonedOptions.layout = nextLayoutSlot()
    const payload = {
      title: name,
      source: panel.source || 'device',
      device_id: panel.device_id,
      tag_name: panel.tag_name,
      datasource_id: panel.datasource_id ?? null,
      table_name: panel.table_name,
      filter_col: panel.filter_col,
      ts_col: panel.ts_col,
      metric: panel.metric,
      window_minutes: panel.window_minutes,
      chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
      options: clonedOptions,
      poll_interval_seconds: panel.poll_interval_seconds || 5,
      dashboard_id: activeDashboardId.value,
      position: panels.value.length,
    }
    const created = await createPanel(payload)
    panels.value.push(created)
    appendLayoutItem(created)
    ElMessage.success('Panel duplicated.')
    duplicateDialogVisible.value = false
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to duplicate panel.')
  } finally {
    duplicating.value = false
  }
}

function remove(panel) {
  deleteTarget.value = panel
  deleteDialogVisible.value = true
}

async function confirmDelete() {
  const panel = deleteTarget.value
  if (!panel) return
  deleting.value = true
  try {
    await deletePanel(panel.id)
    panels.value = panels.value.filter((p) => p.id !== panel.id)
    layout.value = layout.value.filter((it) => it.i !== String(panel.id))
    ElMessage.success('Panel deleted.')
    deleteDialogVisible.value = false
    deleteTarget.value = null
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to delete panel.')
  } finally {
    deleting.value = false
  }
}

// Persist a single panel's poll-interval change without opening the editor.
async function onPollIntervalChange(panel, seconds) {
  if (!canManage.value) return
  try {
    const payload = {
      title: panel.title,
      source: panel.source || 'device',
      device_id: panel.device_id,
      tag_name: panel.tag_name,
      datasource_id: panel.datasource_id ?? null,
      table_name: panel.table_name,
      filter_col: panel.filter_col,
      ts_col: panel.ts_col,
      metric: panel.metric,
      window_minutes: panel.window_minutes,
      chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
      options: panel.options || {},
      poll_interval_seconds: seconds,
      dashboard_id: panel.dashboard_id ?? activeDashboardId.value,
      position: panel.position,
    }
    const updated = await updatePanel(panel.id, payload)
    const i = panels.value.findIndex((p) => p.id === panel.id)
    if (i !== -1) panels.value[i] = updated
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to update poll interval.')
  }
}

// --- Grid layout (Grafana-style drag/resize) ------------------------------
// Find the panel backing a layout item (item.i is the stringified panel id).
function panelById(id) {
  return panels.value.find((p) => String(p.id) === String(id))
}

// Count the series a panel will render. Mirrors the seriesSpecs logic in
// LivePanel.vue so the grid can size the tile to fit them all.
function seriesCount(panel) {
  if (!panel) return 1
  if (panel.source === 'tag') {
    const tags = panel.options?.tags
    if (Array.isArray(tags) && tags.length) return tags.length
    return panel.tag_name ? 1 : 0
  }
  if (panel.source === 'table') {
    const extras = panel.options?.value_cols
    const valueCols = 1 + (Array.isArray(extras) ? extras.filter(Boolean).length : 0)
    const filters = panel.options?.filters
    const hasFilter = !!panel.filter_col && Array.isArray(filters) && filters.length > 0
    return valueCols * (hasFilter ? filters.length : 1)
  }
  return 1
}

// Per-chart-type minimum grid size (cols × rows) that still shows ALL selected
// series AND keeps the ECharts canvas visible. LivePanel's `.panel__chart` has
// min-height: 180px and the panel uses overflow:hidden, so a tile sized below
// (~100px chrome + 180px canvas) clips the chart off — even when the chip row
// above still renders. Each grid row is 26px + 16px gap = 42px effective; so
// ~310px ≈ 8 rows is the floor for any panel with a chart canvas.
function panelMinSize(panel) {
  const n = Math.max(1, seriesCount(panel))
  const clampW = (w) => Math.max(2, Math.min(12, w))
  const clampH = (h) => Math.max(3, Math.min(30, h))
  switch (panel?.chart_type) {
    case 'stat':
      // Single-series: a 64px sparkline sits under the big number; needs h=5.
      // Multi-series: each row is ~47px (26px number + 12px label + gap); add
      // ~100px chrome + ~50px chip-strip-wrap allowance → h ≈ 4 + 2n rows so
      // overflow:hidden never clips the bottom values.
      if (n === 1) return { w: clampW(2), h: clampH(5) }
      return { w: clampW(2), h: clampH(4 + 2 * n) }
    case 'gauge':
      // Small-multiples gauges lay out left → right (one row). Single gauge
      // canvas is 220px, multi gauge cells are 150px each + label.
      return { w: clampW(3 + (n - 1) * 2), h: clampH(8) }
    case 'bargauge':
      return panel.options?.orientation === 'vertical'
        ? { w: clampW(2 + n), h: clampH(7) }            // vertical bars need height
        : { w: clampW(3), h: clampH(4 + n) }            // one ~40px row per series
    case 'table':
      // tablewrap caps at 240px; chrome ~100px → ~340px total max usable.
      // Header is (Time + one column per series); w grows with series count.
      return { w: clampW(2 + n), h: clampH(5) }
    case 'statetimeline':
      // chartStyle in LivePanel scales height by ~44px per series + 40px floor.
      return { w: clampW(4), h: clampH(4 + 2 * n) }
    case 'heatmap':
      // chartStyle in LivePanel scales height by ~34px per series + 60px floor.
      return { w: clampW(4), h: clampH(5 + n) }
    case 'pie':
      // Pie needs near-square aspect plus a legend strip; ~310px each way.
      return { w: clampW(4), h: clampH(8) }
    default:
      // timeseries / bar / scatter / histogram / candlestick — single canvas
      // with min-height 180px. Floor = chrome 100 + 180 ≈ 310px ≈ 8 rows.
      return { w: clampW(3), h: clampH(8) }
  }
}

// Next free slot at the bottom of the grid for a freshly created panel.
function nextLayoutSlot() {
  const maxY = layout.value.reduce((m, it) => Math.max(m, it.y + it.h), 0)
  return { x: 0, y: maxY, w: 6, h: 9 }
}

// Append a layout item for a panel that was just created/duplicated.
function appendLayoutItem(panel) {
  const lay = panel.options?.layout || nextLayoutSlot()
  layout.value.push({ i: String(panel.id), x: lay.x, y: lay.y, w: lay.w, h: lay.h })
}

// Build the GridLayout array from panels. Use each panel's persisted
// options.layout when present; otherwise synthesize a two-up 12-col layout
// from the array index (vertical-compact then tidies any gaps).
function layoutFromPanels() {
  layout.value = panels.value.map((p, idx) => {
    const saved = p.options?.layout
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return { i: String(p.id), x: saved.x, y: saved.y, w: saved.w || 6, h: saved.h || 9 }
    }
    return { i: String(p.id), x: (idx % 2) * 6, y: Math.floor(idx / 2) * 9, w: 6, h: 9 }
  })
}

// Toggle edit mode; persist layout when leaving edit mode.
function toggleEditMode() {
  if (editMode.value) {
    editMode.value = false
    saveLayout()
  } else {
    editMode.value = true
  }
}

// Persist only panels whose {x,y,w,h} changed since last save. Reuses the
// full-payload shape from onPollIntervalChange so the backend round-trips
// every field; layout rides inside options.layout (no schema change).
async function saveLayout() {
  if (!canManage.value) return
  const dirty = []
  for (const item of layout.value) {
    const panel = panelById(item.i)
    if (!panel) continue
    const cur = panel.options?.layout || {}
    if (cur.x === item.x && cur.y === item.y && cur.w === item.w && cur.h === item.h) continue
    dirty.push({ panel, layout: { x: item.x, y: item.y, w: item.w, h: item.h } })
  }
  if (!dirty.length) return
  savingLayout.value = true
  try {
    await Promise.all(
      dirty.map(async ({ panel, layout: lay }) => {
        const payload = {
          title: panel.title,
          source: panel.source || 'device',
          device_id: panel.device_id,
          tag_name: panel.tag_name,
          datasource_id: panel.datasource_id ?? null,
          table_name: panel.table_name,
          filter_col: panel.filter_col,
          ts_col: panel.ts_col,
          metric: panel.metric,
          window_minutes: panel.window_minutes,
          chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
          options: { ...(panel.options || {}), layout: lay },
          poll_interval_seconds: panel.poll_interval_seconds,
          dashboard_id: panel.dashboard_id ?? activeDashboardId.value,
          position: panel.position,
        }
        const updated = await updatePanel(panel.id, payload)
        const i = panels.value.findIndex((p) => p.id === panel.id)
        if (i !== -1) panels.value[i] = updated
      }),
    )
    ElMessage.success('Layout saved.')
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to save layout.')
  } finally {
    savingLayout.value = false
  }
}

// --- Dashboards (multi-board switcher + management) -----------------------
// Load the active dashboard's panels and rebuild the grid layout.
async function loadPanels() {
  panels.value = activeDashboardId.value
    ? await fetchPanels(activeDashboardId.value)
    : []
  layoutFromPanels()
}

// Switch the active dashboard: persist it in the URL query and reload panels.
async function selectDashboard(id) {
  if (id == null || id === activeDashboardId.value) return
  activeDashboardId.value = id
  editMode.value = false
  router.replace({ query: { ...route.query, dashboard: String(id) } }).catch(() => {})
  switching.value = true
  try {
    await loadPanels()
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to load dashboard.')
  } finally {
    switching.value = false
  }
}

const activeDashboard = computed(() =>
  dashboards.value.find((d) => d.id === activeDashboardId.value) || null,
)

onMounted(async () => {
  try {
    const [ds, d, t, conns] = await Promise.all([
      fetchDashboards(),
      fetchDevices().catch(() => []),
      fetchSchemaTables().catch(() => []),
      fetchDatasources().catch(() => []),
    ])
    dashboards.value = ds
    devices.value = d
    schemaTables.value = t
    datasources.value = conns
    // Resolve the active dashboard from ?dashboard=<id>, else the first board.
    const qid = Number(route.query.dashboard)
    const fromQuery = ds.find((x) => x.id === qid)
    activeDashboardId.value = fromQuery ? fromQuery.id : (ds[0]?.id ?? null)
    if (activeDashboardId.value != null && String(activeDashboardId.value) !== route.query.dashboard) {
      router.replace({ query: { ...route.query, dashboard: String(activeDashboardId.value) } }).catch(() => {})
    }
    await loadPanels()
    // Warm the cache for the default "Add panel" table in the background so the
    // first openCreate() call hits the cache instead of waiting for a fetch.
    if (t[0]?.table) {
      fetchSchemaColumns(t[0].table)
        .then(cols => schemaColsCache.set(t[0].table, cols))
        .catch(() => {})
    }
  } catch (e) {
    error.value = e?.message || 'Failed to load dashboard.'
  } finally {
    loading.value = false
  }
})

// --- Manage-dashboards dialog ---------------------------------------------
const manageVisible = ref(false)
const newDashboardTitle = ref('')
const creatingDashboard = ref(false)

function openManage() {
  newDashboardTitle.value = ''
  manageVisible.value = true
}

async function addDashboard() {
  const title = newDashboardTitle.value.trim()
  if (!title) {
    ElMessage.warning('Name is required.')
    return
  }
  creatingDashboard.value = true
  try {
    const created = await createDashboard({ title, position: dashboards.value.length })
    dashboards.value.push(created)
    newDashboardTitle.value = ''
    ElMessage.success('Dashboard created.')
    await selectDashboard(created.id)
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to create dashboard.')
  } finally {
    creatingDashboard.value = false
  }
}

// Rename dialog: small centred form-styled dialog (matches dup-dialog / del-dialog).
const renameDialogVisible = ref(false)
const renaming = ref(false)
const renameTarget = ref(null)
const renameForm = reactive({ title: '' })

function renameDashboard(dash) {
  renameTarget.value = dash
  renameForm.title = dash.title
  renameDialogVisible.value = true
}

async function confirmRename() {
  const dash = renameTarget.value
  if (!dash) return
  const name = renameForm.title.trim()
  if (!name) {
    ElMessage.warning('Name is required.')
    return
  }
  renaming.value = true
  try {
    const updated = await updateDashboard(dash.id, { title: name })
    const i = dashboards.value.findIndex((d) => d.id === dash.id)
    if (i !== -1) dashboards.value[i] = updated
    ElMessage.success('Dashboard renamed.')
    renameDialogVisible.value = false
    renameTarget.value = null
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to rename dashboard.')
  } finally {
    renaming.value = false
  }
}

async function removeDashboard(dash) {
  if (dashboards.value.length <= 1) {
    ElMessage.warning('At least one dashboard must remain.')
    return
  }
  try {
    await ElMessageBox.confirm(
      `Delete "${dash.title}" and all its panels? This cannot be undone.`,
      'Delete dashboard',
      { type: 'warning', confirmButtonText: 'Delete', cancelButtonText: 'Cancel' },
    )
  } catch {
    return
  }
  try {
    await deleteDashboard(dash.id)
    dashboards.value = dashboards.value.filter((d) => d.id !== dash.id)
    ElMessage.success('Dashboard deleted.')
    if (activeDashboardId.value === dash.id) {
      activeDashboardId.value = null
      await selectDashboard(dashboards.value[0]?.id ?? null)
    }
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to delete dashboard.')
  }
}
</script>

<template>
  <div class="live">
    <header class="live__bar">
      <div class="live__title">
        <el-select
          v-if="dashboards.length"
          :model-value="activeDashboardId"
          class="live__dashselect"
          :loading="switching"
          @update:model-value="selectDashboard"
        >
          <el-option v-for="d in dashboards" :key="d.id" :label="d.title" :value="d.id" />
        </el-select>
        <h2 v-else class="live__heading">Live Dashboard</h2>
        <el-button
          v-if="canManage"
          class="live__manage"
          text
          title="Manage dashboards"
          @click="openManage"
        >Manage</el-button>
        <p class="live__sub">Real-time machine panels · per-panel poll interval</p>
      </div>
      <div class="live__clock">
        <span v-if="lastUpdatedLabel" class="live__updated">Updated {{ lastUpdatedLabel }}</span>
      </div>
      <div class="live__actions">
        <el-button
          v-if="canManage && panels.length"
          :type="editMode ? 'success' : 'default'"
          :loading="savingLayout"
          @click="toggleEditMode"
        >
          {{ editMode ? 'Done' : 'Edit Layout' }}
        </el-button>
        <el-button v-if="canManage" type="primary" :disabled="activeDashboardId == null" @click="openCreate">Add panel</el-button>
      </div>
    </header>

    <p v-if="error" class="live__error">{{ error }}</p>

    <p v-else-if="loading" class="live__empty">Loading panels…</p>

    <p v-else-if="!panels.length" class="live__empty">
      No panels yet.
      <template v-if="canManage">Click “Add panel” to create one.</template>
      <template v-else>An admin hasn’t configured any panels.</template>
    </p>

    <GridLayout
      v-else
      v-model:layout="layout"
      class="live__grid"
      :class="{ 'live__grid--editing': editMode }"
      :col-num="12"
      :row-height="26"
      :margin="[16, 16]"
      :is-draggable="editMode && canManage"
      :is-resizable="editMode && canManage"
      :responsive="true"
      :cols="{ lg: 12, md: 12, sm: 1, xs: 1, xxs: 1 }"
      :breakpoints="{ lg: 1200, md: 900, sm: 700, xs: 480, xxs: 0 }"
      vertical-compact
      use-css-transforms
      drag-allow-from=".panel__drag"
    >
      <GridItem
        v-for="item in layout"
        :key="item.i"
        :i="item.i"
        :x="item.x"
        :y="item.y"
        :w="item.w"
        :h="item.h"
        :min-w="panelMinSize(panelById(item.i)).w"
        :min-h="panelMinSize(panelById(item.i)).h"
      >
        <LivePanel
          v-if="panelById(item.i)"
          :panel="panelById(item.i)"
          :device-name="deviceName(panelById(item.i).device_id)"
          :can-manage="canManage"
          :edit-mode="editMode"
          @edit="openEdit"
          @duplicate="duplicate"
          @delete="remove"
          @poll-interval-change="onPollIntervalChange"
          @updated="onPanelUpdated"
        />
      </GridItem>
    </GridLayout>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="1020px">
      <el-form label-position="top">
        <el-form-item label="Title">
          <el-input v-model="form.title" placeholder="e.g. Panel 1" />
        </el-form-item>

        <el-form-item label="Connection">
          <el-select
            v-model="form.datasource_id"
            placeholder="Default (app database)"
            clearable
            style="width: 100%"
          >
            <el-option :value="null" label="Default (app database)" />
            <el-option
              v-for="ds in datasources"
              :key="ds.id"
              :value="ds.id"
              :label="`${ds.name} — ${ds.host}:${ds.port}/${ds.database}`"
            />
          </el-select>
          <span class="editor__hint">
            Saved connections are managed in Settings → Data sources. The table list below
            still reads the app database; routing queries to the selected connection is coming.
          </span>
        </el-form-item>

        <el-form-item label="Data source (table)">
          <el-select
            :model-value="form.table_name"
            placeholder="Select a table"
            filterable
            style="width: 100%"
            @update:model-value="onTableChange"
          >
            <el-option v-for="t in schemaTables" :key="t.table" :label="t.label" :value="t.table" />
          </el-select>
        </el-form-item>

        <el-form-item label="Value column">
          <div class="taglist">
            <!-- Each value row: colour swatch · value column · its display unit. -->
            <!-- Primary value column (stored in form.metric for back-compat). -->
            <div class="taglist__row">
              <span class="taglist__swatch" :style="{ background: colorAt(0) }" />
              <el-select v-model="form.metric" placeholder="Value" filterable class="taglist__select">
                <el-option v-for="c in schemaCols.value_columns" :key="c" :label="c" :value="c" />
              </el-select>
              <!-- Unit lives here only when there's no filter column (value columns
                   are the series). Filtered panels show units in "Series values". -->
              <el-select
                v-if="!form.filter_col"
                :model-value="form.units[form.metric]"
                placeholder="Unit"
                clearable
                filterable
                class="taglist__unit"
                title="Display unit for this value"
                @update:model-value="(v) => setUnit(form.metric, v)"
              >
                <el-option-group v-for="g in UNIT_GROUPS" :key="g.category" :label="g.category">
                  <el-option v-for="u in g.units" :key="u.value" :label="u.label" :value="u.value" />
                </el-option-group>
              </el-select>
              <!-- Spacer keeps row widths aligned with the extra rows that have a remove button. -->
              <span class="taglist__remove taglist__remove--placeholder" />
            </div>
            <!-- Extra value columns: each becomes its own series, filtered the same way. -->
            <div v-for="(c, i) in form.value_cols" :key="i" class="taglist__row">
              <span class="taglist__swatch" :style="{ background: colorAt(i + 1) }" />
              <el-select v-model="form.value_cols[i]" placeholder="Value" filterable class="taglist__select">
                <el-option v-for="opt in schemaCols.value_columns" :key="opt" :label="opt" :value="opt" />
              </el-select>
              <el-select
                v-if="!form.filter_col"
                :model-value="form.units[form.value_cols[i]]"
                placeholder="Unit"
                clearable
                filterable
                class="taglist__unit"
                title="Display unit for this value"
                @update:model-value="(v) => setUnit(form.value_cols[i], v)"
              >
                <el-option-group v-for="g in UNIT_GROUPS" :key="g.category" :label="g.category">
                  <el-option v-for="u in g.units" :key="u.value" :label="u.label" :value="u.value" />
                </el-option-group>
              </el-select>
              <el-button
                class="taglist__remove"
                text
                title="Remove value"
                @click="removeValueCol(i)"
              >×</el-button>
            </div>
            <el-button class="taglist__add" text @click="addValueCol">+ Value</el-button>
          </div>
        </el-form-item>
        <el-form-item label="Timestamp column">
          <el-select v-model="form.ts_col" placeholder="None (live sampling)" clearable style="width: 100%">
            <el-option v-for="c in schemaCols.ts_columns" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>

        <el-form-item label="Filter column (series)">
          <el-select
            :model-value="form.filter_col"
            placeholder="None — whole table as one series"
            clearable
            filterable
            style="width: 100%"
            @update:model-value="onFilterColChange"
          >
            <el-option v-for="c in schemaCols.filter_columns" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>

        <el-form-item v-if="form.filter_col" label="Series values">
          <div class="taglist">
            <div v-for="(v, i) in form.filters" :key="i" class="taglist__row">
              <span class="taglist__swatch" :style="{ background: colorAt(i) }" />
              <el-select v-model="form.filters[i]" placeholder="Value" filterable class="taglist__select">
                <el-option v-for="opt in filterValues" :key="opt" :label="opt" :value="opt" />
              </el-select>
              <el-select
                :model-value="form.units[form.filters[i]]"
                placeholder="Unit"
                clearable
                filterable
                class="taglist__unit"
                title="Display unit for this series"
                @update:model-value="(v) => setUnit(form.filters[i], v)"
              >
                <el-option-group v-for="g in UNIT_GROUPS" :key="g.category" :label="g.category">
                  <el-option v-for="u in g.units" :key="u.value" :label="u.label" :value="u.value" />
                </el-option-group>
              </el-select>
              <el-button
                class="taglist__remove"
                text
                :disabled="form.filters.length <= 1"
                title="Remove series"
                @click="removeFilter(i)"
              >×</el-button>
            </div>
            <el-button class="taglist__add" text @click="addFilter">+ Add series</el-button>
          </div>
        </el-form-item>

        <el-form-item label="Expression (optional)">
          <el-input
            v-model="form.mathExpr"
            placeholder="e.g. value * 1.8 + 32, sqrt(value), value / 100"
            clearable
          />
          <span class="editor__hint">
            Applied to every reading before display. Variable: <code>value</code>.
            Functions: <code>abs sqrt pow min max floor ceil round</code>.
          </span>
        </el-form-item>

        <div class="editor__row">
          <el-form-item label="Window (minutes)" class="editor__col">
            <el-input-number v-model="form.window_minutes" :min="1" :max="1440" style="width: 100%" />
          </el-form-item>
          <el-form-item label="Poll interval" class="editor__col">
            <el-select v-model="form.poll_interval_seconds" style="width: 100%">
              <el-option v-for="it in POLL_INTERVALS" :key="it.value" :label="it.label" :value="it.value" />
            </el-select>
          </el-form-item>
        </div>

        <!-- Visualization picker (Grafana-style) -->
        <el-form-item label="Visualization">
          <div class="vizpicker">
            <button
              v-for="v in VIZ_TYPES"
              :key="v.value"
              type="button"
              class="vizpicker__item"
              :class="{ 'vizpicker__item--active': form.chart_type === v.value }"
              :title="v.hint"
              @click="form.chart_type = v.value; onVizTypeChange(v.value)"
            >
              <el-icon class="vizpicker__icon"><component :is="v.icon" /></el-icon>
              <span class="vizpicker__label">{{ v.label }}</span>
            </button>
          </div>
        </el-form-item>

        <!-- Per-type parameter sub-menu -->
        <div class="submenu">
          <div class="submenu__head">{{ VIZ_TYPES.find((v) => v.value === form.chart_type)?.label }} options</div>
          <div class="submenu__grid">
            <el-form-item v-for="f in currentSchema" :key="f.key" :label="f.label" class="submenu__field">
              <el-switch v-if="f.type === 'switch'" v-model="form.options[f.key]" />
              <el-select v-else-if="f.type === 'enum'" v-model="form.options[f.key]" style="width: 100%">
                <el-option v-for="o in f.options" :key="o" :label="o" :value="o" />
              </el-select>
              <el-input-number
                v-else
                v-model="form.options[f.key]"
                :min="f.min"
                :max="f.max"
                :controls="false"
                :placeholder="f.nullable ? 'none' : ''"
                style="width: 100%"
              />
            </el-form-item>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="saving" @click="save">Save</el-button>
      </template>
    </el-dialog>

    <!-- Duplicate panel: small centred form-styled dialog -->
    <el-dialog
      v-model="duplicateDialogVisible"
      title="Duplicate panel"
      width="420px"
      align-center
      append-to-body
      class="dup-dialog"
    >
      <el-form label-position="top" @submit.prevent="confirmDuplicate">
        <el-form-item label="New panel name">
          <el-input
            v-model="duplicateForm.title"
            placeholder="e.g. Boiler #1 Temperature (Copy)"
            autofocus
            clearable
            @keyup.enter="confirmDuplicate"
          />
        </el-form-item>
        <p v-if="duplicateSource" class="dup-dialog__hint">
          Copies all settings from <strong>{{ duplicateSource.title }}</strong>.
        </p>
      </el-form>
      <template #footer>
        <el-button @click="duplicateDialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="duplicating" @click="confirmDuplicate">Create</el-button>
      </template>
    </el-dialog>

    <!-- Delete panel: small centred confirm dialog -->
    <el-dialog
      v-model="deleteDialogVisible"
      title="Delete panel"
      width="420px"
      align-center
      append-to-body
      class="del-dialog"
    >
      <p v-if="deleteTarget" class="del-dialog__msg">
        Delete <strong>{{ deleteTarget.title }}</strong>?
      </p>
      <p class="del-dialog__hint">This action cannot be undone.</p>
      <template #footer>
        <el-button @click="deleteDialogVisible = false">Cancel</el-button>
        <el-button type="danger" :loading="deleting" @click="confirmDelete">Delete</el-button>
      </template>
    </el-dialog>

    <!-- Rename dashboard: small centred form-styled dialog (matches dup-dialog). -->
    <el-dialog
      v-model="renameDialogVisible"
      title="Rename dashboard"
      width="420px"
      align-center
      append-to-body
      class="rename-dialog"
    >
      <el-form label-position="top" @submit.prevent="confirmRename">
        <el-form-item label="New name">
          <el-input
            v-model="renameForm.title"
            placeholder="Dashboard name"
            autofocus
            clearable
            @keyup.enter="confirmRename"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="renameDialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="renaming" @click="confirmRename">Save</el-button>
      </template>
    </el-dialog>

    <!-- Manage dashboards: list + rename/delete + create -->
    <el-dialog
      v-model="manageVisible"
      title="Manage dashboards"
      width="480px"
      align-center
      append-to-body
      class="manage-dialog"
    >
      <el-table :data="dashboards" size="small" max-height="320">
        <el-table-column prop="title" label="Name" />
        <el-table-column label="" width="150" align="right">
          <template #default="{ row }">
            <el-button text size="small" @click="renameDashboard(row)">Rename</el-button>
            <el-button
              text
              size="small"
              type="danger"
              :disabled="dashboards.length <= 1"
              @click="removeDashboard(row)"
            >Delete</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="manage-dialog__new">
        <el-input
          v-model="newDashboardTitle"
          placeholder="New dashboard name"
          clearable
          @keyup.enter="addDashboard"
        />
        <el-button type="primary" :loading="creatingDashboard" @click="addDashboard">Add</el-button>
      </div>
      <template #footer>
        <el-button @click="manageVisible = false">Close</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.live__bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--space-4);
}

.live__bar > :nth-child(1) {
  grid-column: 1;
  justify-self: start;
}

.live__clock {
  grid-column: 2;
  justify-self: center;
  text-align: center;
}

.live__actions {
  grid-column: 3;
  justify-self: end;
  display: flex;
  gap: var(--space-2);
}

.live__title {
  display: grid;
  grid-template-columns: auto auto;
  align-items: center;
  column-gap: var(--space-2);
}

.live__dashselect {
  width: 220px;
}

.live__dashselect :deep(.el-select__wrapper) {
  font-size: 18px;
  font-weight: 600;
}

.live__manage {
  justify-self: start;
}

/* Sub-line spans both columns under the selector + manage button. */
.live__title .live__sub {
  grid-column: 1 / -1;
}

.live__updated {
  font-size: 13px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.live__heading {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--fg);
}

.live__sub {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--fg-muted);
}

.manage-dialog__new {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* GridLayout container — items are absolutely positioned by the library. */
.live__grid {
  width: 100%;
}

/* Each grid cell is just a positioning shell; LivePanel paints its own card. */
.live__grid :deep(.vgl-item) {
  background: transparent;
  box-sizing: border-box;
  touch-action: none;
}

/* Edit-mode affordance: dashed accent outline + visible resize handle. */
.live__grid--editing :deep(.vgl-item) {
  outline: 1px dashed var(--accent, #4f9cff);
  outline-offset: -1px;
  border-radius: var(--radius);
}

.live__grid :deep(.vgl-item__resizer) {
  display: none;
}

.live__grid--editing :deep(.vgl-item__resizer) {
  display: block;
}

/* Placeholder shown while dragging a tile to a new slot. */
.live__grid :deep(.vgl-item--placeholder) {
  background: var(--accent, #4f9cff);
  opacity: 0.18;
  border-radius: var(--radius);
}

.live__empty {
  color: var(--fg-muted);
  font-size: 14px;
  padding: var(--space-6) 0;
  text-align: center;
}

.live__error {
  color: #f5a524;
  margin: 0;
  font-size: 13px;
}

/* Editor */
.editor__row {
  display: flex;
  gap: var(--space-3);
}

.editor__col {
  flex: 1;
}

.editor__hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fg-muted);
}

.editor__hint code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  padding: 0 4px;
  background: var(--bg-elev, rgba(255, 255, 255, 0.06));
  border-radius: 3px;
}

/* Multi-tag list */
.taglist {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.taglist__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.taglist__swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}

.taglist__select {
  flex: 1;
  min-width: 0;
}

.taglist__unit {
  width: 108px;
  flex-shrink: 0;
}

.taglist__remove {
  flex-shrink: 0;
  font-size: 18px;
  line-height: 1;
  padding: 0 6px;
}

/* Invisible spacer that keeps the primary value row's gutter aligned with the
 * extra rows (which carry a "×" remove button). */
.taglist__remove--placeholder {
  width: 25px;
  height: 1px;
  display: inline-block;
  pointer-events: none;
}

.taglist__add {
  align-self: flex-start;
}

.vizpicker {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
  width: 100%;
}

.vizpicker__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: all 0.12s ease;
}

.vizpicker__item:hover {
  border-color: var(--accent);
  color: var(--fg);
}

.vizpicker__item--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.vizpicker__icon {
  font-size: 18px;
}

.vizpicker__label {
  font-size: 11px;
  text-align: center;
  line-height: 1.2;
}

.submenu {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  margin-top: var(--space-2);
}

.submenu__head {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
  margin-bottom: var(--space-2);
}

.submenu__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 var(--space-4);
}

.submenu__field {
  margin-bottom: var(--space-2);
}

/* Duplicate-panel dialog */
.dup-dialog__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}

/* Delete-panel dialog */
.del-dialog__msg {
  margin: 0 0 var(--space-2) 0;
  font-size: 14px;
  color: var(--fg);
}

.del-dialog__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
</style>
