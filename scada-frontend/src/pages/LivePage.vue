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
import { fetchDevices, fetchMetrics } from '@/api/readings'
import { fetchPanels, createPanel, updatePanel, deletePanel } from '@/api/panels'

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
const loading = ref(true)
const error = ref('')

// --- Editor dialog state ---------------------------------------------------
const dialogVisible = ref(false)
const editingId = ref(null) // null = create mode
const saving = ref(false)
const dialogMetrics = ref([])
const form = reactive({
  title: '',
  device_id: null,
  metric: null,
  window_minutes: 15,
  chart_type: 'timeseries',
  options: defaultOptions('timeseries'),
})

const dialogTitle = computed(() => (editingId.value ? 'Edit panel' : 'Add panel'))
const currentSchema = computed(() => PARAM_SCHEMA[form.chart_type] || [])

const deviceName = (id) => devices.value.find((d) => d.id === id)?.name || ''

async function loadDialogMetrics() {
  if (!form.device_id) {
    dialogMetrics.value = []
    return
  }
  dialogMetrics.value = await fetchMetrics(form.device_id)
}

async function onDialogDeviceChange() {
  await loadDialogMetrics()
  if (!dialogMetrics.value.some((m) => m.metric === form.metric)) {
    form.metric = dialogMetrics.value[0]?.metric ?? null
  }
}

// Switching viz type resets its parameters to that type's defaults.
function onVizTypeChange(type) {
  form.options = defaultOptions(type)
}

function openCreate() {
  editingId.value = null
  form.title = ''
  form.device_id = devices.value[0]?.id ?? null
  form.metric = null
  form.window_minutes = 15
  form.chart_type = 'timeseries'
  form.options = defaultOptions('timeseries')
  dialogMetrics.value = []
  dialogVisible.value = true
  loadDialogMetrics().then(() => {
    form.metric = dialogMetrics.value[0]?.metric ?? null
  })
}

function openEdit(panel) {
  editingId.value = panel.id
  form.title = panel.title
  form.device_id = panel.device_id
  form.metric = panel.metric
  form.window_minutes = panel.window_minutes
  form.chart_type = panel.chart_type === 'line' ? 'timeseries' : panel.chart_type
  // Merge saved options over defaults so newly added params get sensible values.
  form.options = { ...defaultOptions(form.chart_type), ...(panel.options || {}) }
  dialogVisible.value = true
  loadDialogMetrics()
}

async function save() {
  if (!form.title.trim()) {
    ElMessage.warning('Title is required.')
    return
  }
  if (!form.device_id || !form.metric) {
    ElMessage.warning('Pick a device and metric.')
    return
  }
  saving.value = true
  try {
    const payload = {
      title: form.title.trim(),
      device_id: form.device_id,
      metric: form.metric,
      window_minutes: form.window_minutes,
      chart_type: form.chart_type,
      options: { ...form.options },
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

async function remove(panel) {
  try {
    await ElMessageBox.confirm(
      `Delete panel "${panel.title}"?`,
      'Confirm delete',
      { type: 'warning', confirmButtonText: 'Delete', cancelButtonText: 'Cancel' },
    )
  } catch {
    return
  }
  try {
    await deletePanel(panel.id)
    panels.value = panels.value.filter((p) => p.id !== panel.id)
    ElMessage.success('Panel deleted.')
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to delete panel.')
  }
}

onMounted(async () => {
  try {
    const [p, d] = await Promise.all([fetchPanels(), fetchDevices()])
    panels.value = p
    devices.value = d
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
        <p class="live__sub">Real-time machine panels · refreshing every 5s</p>
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
        @delete="remove"
      />
    </section>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px">
      <el-form label-position="top">
        <el-form-item label="Title">
          <el-input v-model="form.title" placeholder="e.g. Boiler #1 Temperature" />
        </el-form-item>

        <div class="editor__row">
          <el-form-item label="Device (connection)" class="editor__col">
            <el-select v-model="form.device_id" placeholder="Device" @change="onDialogDeviceChange" style="width: 100%">
              <el-option v-for="d in devices" :key="d.id" :label="d.name" :value="d.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Metric" class="editor__col">
            <el-select v-model="form.metric" placeholder="Metric" style="width: 100%">
              <el-option v-for="m in dialogMetrics" :key="m.metric" :label="m.metric" :value="m.metric" />
            </el-select>
          </el-form-item>
        </div>

        <el-form-item label="Window (minutes)">
          <el-input-number v-model="form.window_minutes" :min="1" :max="1440" />
        </el-form-item>

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
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.live__bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
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
</style>
