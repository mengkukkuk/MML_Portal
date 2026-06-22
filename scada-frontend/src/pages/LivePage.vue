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
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import LivePanel from '@/components/LivePanel.vue'
import { fetchDevices } from '@/api/readings'
import { fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues } from '@/api/schema'
import { fetchPanels, createPanel, updatePanel, deletePanel } from '@/api/panels'
import { colorAt } from '@/utils/seriesPalette'
import { compileExpr } from '@/utils/mathExpr'

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

// --- Visualization catalogue (mirrors LivePanel's renderers) ---------------
const VIZ_TYPES = [
  { value: 'timeseries', label: 'Time series', icon: 'TrendCharts', hint: 'Time based line & area charts' },
  { value: 'bar', label: 'Bar chart', icon: 'Histogram', hint: 'Value bars over time' },
  { value: 'stat', label: 'Stat', icon: 'Odometer', hint: 'Big value & sparkline' },
  { value: 'gauge', label: 'Gauge', icon: 'Compass', hint: 'Radial gauge with thresholds' },
  { value: 'bargauge', label: 'Bar gauge', icon: 'Sort', hint: 'Horizontal / vertical level bar' },
  { value: 'histogram', label: 'Histogram', icon: 'DataAnalysis', hint: 'Distribution of values' },
  { value: 'table', label: 'Table', icon: 'Grid', hint: 'Recent readings table' },
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
}

function defaultOptions(type) {
  const out = {}
  for (const f of PARAM_SCHEMA[type] || []) out[f.key] = f.default
  return out
}

const panels = ref([])
const devices = ref([])
const schemaTables = ref([])   // [{ table, label }]
const schemaCols = ref({ value_columns: [], ts_columns: [], filter_columns: [] })
const filterValues = ref([])   // distinct values of the chosen filter column
const loading = ref(true)
const error = ref('')

// --- Editor dialog state ---------------------------------------------------
const dialogVisible = ref(false)
const editingId = ref(null) // null = create mode
const saving = ref(false)
const form = reactive({
  title: '',
  table_name: null,
  metric: null,      // value column
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
  form.filters.splice(i, 1)
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
async function applyBinding({ table, metric, filter_col, filters, ts_col }) {
  // Fall back to the first available table if the requested one isn't selectable.
  const exists = schemaTables.value.some((t) => t.table === table)
  form.table_name = exists ? table : (schemaTables.value[0]?.table ?? null)
  if (!form.table_name) {
    schemaCols.value = { value_columns: [], ts_columns: [], filter_columns: [] }
    form.metric = null; form.filter_col = null; form.filters = []; form.ts_col = null
    filterValues.value = []
    return
  }
  try {
    schemaCols.value = await fetchSchemaColumns(form.table_name)
  } catch {
    schemaCols.value = { value_columns: [], ts_columns: [], filter_columns: [] }
  }
  const cols = schemaCols.value
  form.metric = cols.value_columns.includes(metric) ? metric : (cols.value_columns[0] ?? null)
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
  form.mathExpr = ''
  form.window_minutes = 15
  form.chart_type = 'timeseries'
  form.options = defaultOptions('timeseries')
  form.poll_interval_seconds = 5
  await applyBinding({
    table: schemaTables.value[0]?.table ?? null,
    metric: null, filter_col: null, filters: [], ts_col: null,
  })
  dialogVisible.value = true
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
  form.chart_type = panel.chart_type === 'line' ? 'timeseries' : panel.chart_type
  // `filters`/`tags` and `mathExpr` live outside form.options — onVizTypeChange
  // replaces form.options wholesale and would otherwise drop them.
  const { tags: _t, filters: _f, mathExpr: _m, ...vizOpts } = panel.options || {}
  form.options = { ...defaultOptions(form.chart_type), ...vizOpts }
  form.mathExpr = panel.options?.mathExpr || ''
  form.window_minutes = panel.window_minutes
  form.poll_interval_seconds = panel.poll_interval_seconds || 5

  const binding = panel.source === 'table'
    ? {
        table: panel.table_name,
        metric: panel.metric,
        filter_col: panel.filter_col,
        filters: panel.options?.filters?.length ? [...panel.options.filters] : [],
        ts_col: panel.ts_col,
      }
    : (legacyBinding(panel) || { table: null, metric: null, filter_col: null, filters: [], ts_col: null })
  await applyBinding(binding)
  dialogVisible.value = true
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
    const payload = {
      title: form.title.trim(),
      source: 'table',
      device_id: null,
      tag_name: null,
      table_name: form.table_name,
      metric: form.metric,
      filter_col: form.filter_col || null,
      ts_col: form.ts_col || null,
      window_minutes: form.window_minutes,
      chart_type: form.chart_type,
      // Filter values ride in options.filters (parallel to the old options.tags).
      options: { ...form.options, filters: [...form.filters], ...extraOpts },
      poll_interval_seconds: form.poll_interval_seconds,
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
    const payload = {
      title: name,
      source: panel.source || 'device',
      device_id: panel.device_id,
      tag_name: panel.tag_name,
      table_name: panel.table_name,
      filter_col: panel.filter_col,
      ts_col: panel.ts_col,
      metric: panel.metric,
      window_minutes: panel.window_minutes,
      chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
      options: JSON.parse(JSON.stringify(panel.options || {})),
      poll_interval_seconds: panel.poll_interval_seconds || 5,
      position: panels.value.length,
    }
    const created = await createPanel(payload)
    panels.value.push(created)
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
      table_name: panel.table_name,
      filter_col: panel.filter_col,
      ts_col: panel.ts_col,
      metric: panel.metric,
      window_minutes: panel.window_minutes,
      chart_type: panel.chart_type === 'line' ? 'timeseries' : panel.chart_type,
      options: panel.options || {},
      poll_interval_seconds: seconds,
      position: panel.position,
    }
    const updated = await updatePanel(panel.id, payload)
    const i = panels.value.findIndex((p) => p.id === panel.id)
    if (i !== -1) panels.value[i] = updated
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to update poll interval.')
  }
}

onMounted(async () => {
  try {
    const [p, d, t] = await Promise.all([
      fetchPanels(),
      fetchDevices().catch(() => []),
      fetchSchemaTables().catch(() => []),
    ])
    panels.value = p
    devices.value = d
    schemaTables.value = t
  } catch (e) {
    error.value = e?.message || 'Failed to load dashboard.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="live">
    <header class="live__bar">
      <div>
        <h2 class="live__heading">Live Dashboard</h2>
        <p class="live__sub">Real-time machine panels · per-panel poll interval</p>
      </div>
      <div class="live__clock">
        <span v-if="lastUpdatedLabel" class="live__updated">Updated {{ lastUpdatedLabel }}</span>
      </div>
      <el-button v-if="canManage" type="primary" @click="openCreate">Add panel</el-button>
    </header>

    <p v-if="error" class="live__error">{{ error }}</p>

    <p v-else-if="loading" class="live__empty">Loading panels…</p>

    <p v-else-if="!panels.length" class="live__empty">
      No panels yet.
      <template v-if="canManage">Click “Add panel” to create one.</template>
      <template v-else>An admin hasn’t configured any panels.</template>
    </p>

    <section v-else class="live__grid">
      <LivePanel
        v-for="panel in panels"
        :key="panel.id"
        :panel="panel"
        :device-name="deviceName(panel.device_id)"
        :can-manage="canManage"
        @edit="openEdit"
        @duplicate="duplicate"
        @delete="remove"
        @poll-interval-change="onPollIntervalChange"
        @updated="onPanelUpdated"
      />
    </section>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px">
      <el-form label-position="top">
        <el-form-item label="Title">
          <el-input v-model="form.title" placeholder="e.g. Boiler #1 Temperature" />
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

        <div class="editor__row">
          <el-form-item label="Value column" class="editor__col">
            <el-select v-model="form.metric" placeholder="Value" style="width: 100%">
              <el-option v-for="c in schemaCols.value_columns" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="Timestamp column" class="editor__col">
            <el-select v-model="form.ts_col" placeholder="None (live sampling)" clearable style="width: 100%">
              <el-option v-for="c in schemaCols.ts_columns" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
        </div>

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

.live__bar > .el-button {
  grid-column: 3;
  justify-self: end;
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

.live__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--space-4);
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

.taglist__remove {
  flex-shrink: 0;
  font-size: 18px;
  line-height: 1;
  padding: 0 6px;
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
