<script setup>
/**
 * SettingsPage — the control-console for portal-wide parameters (route: /settings).
 * Laid out as rack modules: APPEARANCE (color faceplate), ACQUISITION (poll
 * cadence + alerts), and DATA SOURCES (admin-managed saved DB connections).
 *
 * Theme + acquisition prefs persist to localStorage via the settings store
 * (theme applies live; acquisition needs Save). Connections live server-side
 * (api/datasources) so Live panels can bind to them; each saves on its own and
 * can be tested against a real database.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { useSettingsStore, THEMES } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import {
  fetchDatasources,
  createDatasource,
  updateDatasource,
  deleteDatasource,
  testDatasource,
} from '@/api/datasources'

const store = useSettingsStore()
const { theme, pollSeconds, notifyOnCritical } = storeToRefs(store)
const auth = useAuthStore()
const isAdmin = computed(() => auth.role === 'admin')

const collapsed = reactive({ appearance: true, acquisition: true, datasources: true })

const POLL_PRESETS = [
  { s: 5, label: '5s' },
  { s: 10, label: '10s' },
  { s: 30, label: '30s' },
  { s: 60, label: '1m' },
]
const DS_TYPES = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'timescaledb', label: 'TimescaleDB' },
]
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

const LED_BY_STATE = { testing: 'led--warn led--pulse', ok: 'led--ok', error: 'led--crit' }

// --- Acquisition prefs: dirty tracking (theme commits instantly; connections
//     save individually, so the commit bar governs poll/notify only) ---------
const fingerprint = () => JSON.stringify({ p: pollSeconds.value, n: notifyOnCritical.value })
const savedPrefs = ref('')
const dirty = computed(() => savedPrefs.value !== fingerprint())

function pickTheme(id) {
  store.applyTheme(id)
}
function setPoll(seconds) {
  pollSeconds.value = seconds
}
function commit() {
  store.savePrefs()
  savedPrefs.value = fingerprint()
  ElMessage.success('Settings committed')
}

// --- Data sources (server-side) --------------------------------------------
const datasources = ref([])
const dsLoading = ref(false)
const rowTest = reactive({}) // id -> { state, message }

const dialogVisible = ref(false)
const editingDsId = ref(null) // null = create
const savingDs = ref(false)
const blankDs = () => ({
  name: '',
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: '',
  db_schema: 'public',
  username: 'postgres',
  password: '',
  sslmode: 'prefer',
})
const dsForm = reactive(blankDs())
const dsTest = reactive({ state: 'idle', message: '' }) // idle|testing|ok|error

// Delete-confirmation dialog (mirrors LivePage's del-dialog).
const deleteDialogVisible = ref(false)
const deletingDs = ref(false)
const deleteTarget = ref(null)

const dsDialogTitle = computed(() => (editingDsId.value ? 'Edit connection' : 'Add connection'))
const dsTestLed = computed(() => LED_BY_STATE[dsTest.state] || '')
const editingHasPassword = computed(
  () => datasources.value.find((d) => d.id === editingDsId.value)?.has_password,
)
function rowLed(id) {
  return LED_BY_STATE[rowTest[id]?.state] || ''
}

async function loadDatasources() {
  dsLoading.value = true
  try {
    datasources.value = await fetchDatasources()
  } catch (e) {
    if (e?.response?.status !== 403) ElMessage.error('Failed to load connections.')
  } finally {
    dsLoading.value = false
  }
}

function openCreateDs() {
  editingDsId.value = null
  Object.assign(dsForm, blankDs())
  dsTest.state = 'idle'
  dsTest.message = ''
  dialogVisible.value = true
}
function openEditDs(ds) {
  editingDsId.value = ds.id
  Object.assign(dsForm, {
    name: ds.name,
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database: ds.database,
    db_schema: ds.db_schema || 'public',
    username: ds.username,
    password: '', // blank = keep the stored secret
    sslmode: ds.sslmode,
  })
  dsTest.state = 'idle'
  dsTest.message = ''
  dialogVisible.value = true
}

async function testInDialog() {
  dsTest.state = 'testing'
  dsTest.message = 'Opening connection…'
  try {
    const r = await testDatasource({
      datasource_id: editingDsId.value ?? undefined,
      type: dsForm.type,
      host: dsForm.host,
      port: dsForm.port,
      database: dsForm.database,
      username: dsForm.username,
      password: dsForm.password || undefined,
      sslmode: dsForm.sslmode,
    })
    dsTest.state = r.ok ? 'ok' : 'error'
    dsTest.message = r.server_version ? `${r.message} · ${r.server_version}` : r.message
  } catch (e) {
    dsTest.state = 'error'
    dsTest.message = e?.response?.data?.detail || 'Test failed.'
  }
}

async function saveDs() {
  if (!dsForm.name.trim()) {
    ElMessage.warning('Name is required.')
    return
  }
  savingDs.value = true
  try {
    const payload = {
      name: dsForm.name.trim(),
      type: dsForm.type,
      host: dsForm.host.trim(),
      port: dsForm.port,
      database: dsForm.database.trim(),
      db_schema: dsForm.db_schema.trim() || 'public',
      username: dsForm.username.trim(),
      sslmode: dsForm.sslmode,
      ...(dsForm.password ? { password: dsForm.password } : {}),
    }
    if (editingDsId.value) {
      const updated = await updateDatasource(editingDsId.value, payload)
      const i = datasources.value.findIndex((d) => d.id === editingDsId.value)
      if (i !== -1) datasources.value[i] = updated
      ElMessage.success('Connection updated.')
    } else {
      const created = await createDatasource(payload)
      datasources.value.push(created)
      datasources.value.sort((a, b) => a.name.localeCompare(b.name))
      ElMessage.success('Connection saved.')
    }
    dialogVisible.value = false
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Failed to save connection.')
  } finally {
    savingDs.value = false
  }
}

function removeDs(ds) {
  deleteTarget.value = ds
  deleteDialogVisible.value = true
}

async function confirmDeleteDs() {
  const ds = deleteTarget.value
  if (!ds) return
  deletingDs.value = true
  try {
    await deleteDatasource(ds.id)
    datasources.value = datasources.value.filter((d) => d.id !== ds.id)
    delete rowTest[ds.id]
    ElMessage.success('Connection deleted.')
    deleteDialogVisible.value = false
    deleteTarget.value = null
  } catch (e) {
    ElMessage.error(e?.response?.data?.detail || 'Delete failed.')
  } finally {
    deletingDs.value = false
  }
}

async function testRow(ds) {
  rowTest[ds.id] = { state: 'testing', message: 'Opening connection…' }
  try {
    const r = await testDatasource({ datasource_id: ds.id })
    rowTest[ds.id] = {
      state: r.ok ? 'ok' : 'error',
      message: r.server_version ? `${r.message} · ${r.server_version}` : r.message,
    }
  } catch (e) {
    rowTest[ds.id] = { state: 'error', message: e?.response?.data?.detail || 'Test failed.' }
  }
}

onMounted(async () => {
  savedPrefs.value = fingerprint()
  await loadDatasources()
})
</script>

<template>
  <div class="cfg">
    <!-- ── Console header ─────────────────────────────────────────────── -->
    <header class="cfg__head">
      <div>
        <p class="cfg__eyebrow">MML · SYSTEM CONFIGURATION</p>
        <h1 class="cfg__title">Console Settings</h1>
      </div>
      <div class="cfg__sync" :class="{ 'cfg__sync--dirty': dirty }">
        <span class="led" :class="dirty ? 'led--warn' : 'led--ok'"></span>
        {{ dirty ? 'UNSAVED CHANGES' : 'CONFIG SYNCED' }}
      </div>
    </header>

    <!-- ── Module 1 · Appearance ──────────────────────────────────────── -->
    <section class="mod" :class="{ 'mod--collapsed': collapsed.appearance }">
      <header class="mod__head" @click="collapsed.appearance = !collapsed.appearance">
        <span class="mod__tag">Appearance</span>
        <span class="mod__sub">HMI color faceplate</span>
        <el-icon class="mod__chevron" :class="{ 'mod__chevron--open': !collapsed.appearance }"><ArrowRight /></el-icon>
      </header>
      <div class="mod__body" v-show="!collapsed.appearance">
        <p class="fld__label">Color theme</p>
        <div class="plates" role="group" aria-label="Color theme">
          <button
            v-for="t in THEMES"
            :key="t.id"
            type="button"
            class="plate"
            :class="{ 'plate--active': theme === t.id }"
            :aria-pressed="theme === t.id"
            @click="pickTheme(t.id)"
          >
            <span class="plate__screen" :style="{ background: t.preview.bg }">
              <span
                class="plate__win"
                :style="{ background: t.preview.panel, borderColor: t.preview.accent }"
              >
                <span class="plate__accent" :style="{ background: t.preview.accent }"></span>
                <span class="plate__row" :style="{ background: t.preview.fg }"></span>
                <span
                  class="plate__row plate__row--short"
                  :style="{ background: t.preview.fg }"
                ></span>
                <span
                  class="plate__gauge"
                  :style="{
                    borderColor: t.preview.accent,
                    boxShadow: '0 0 10px ' + t.preview.accent + '66',
                  }"
                ></span>
              </span>
            </span>
            <span class="plate__foot">
              <span class="led" :class="theme === t.id ? 'led--ok' : ''"></span>
              <span class="plate__name">{{ t.name }}</span>
              <span class="plate__hex">{{ t.preview.accent }}</span>
            </span>
            <span class="plate__blurb">{{ t.blurb }}</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ── Module 2 · Acquisition ─────────────────────────────────────── -->
    <section class="mod" :class="{ 'mod--collapsed': collapsed.acquisition }">
      <header class="mod__head" @click="collapsed.acquisition = !collapsed.acquisition">
        <span class="mod__tag">Acquisition</span>
        <span class="mod__sub">Default polling cadence</span>
        <el-icon class="mod__chevron" :class="{ 'mod__chevron--open': !collapsed.acquisition }"><ArrowRight /></el-icon>
      </header>
      <div class="mod__body acq" v-show="!collapsed.acquisition">
        <div class="acq__row">
          <div class="acq__label">
            <p class="fld__label">Default poll interval</p>
            <p class="fld__hint">Sliding-window refresh used by Live &amp; Trends tiles.</p>
          </div>
          <div class="acq__ctl">
            <el-input-number v-model="pollSeconds" :min="1" :max="3600" controls-position="right" />
            <span class="acq__unit">seconds</span>
            <div class="chips">
              <button
                v-for="p in POLL_PRESETS"
                :key="p.s"
                type="button"
                class="chip"
                :class="{ 'chip--on': pollSeconds === p.s }"
                @click="setPoll(p.s)"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="acq__row acq__row--divider">
          <div class="acq__label">
            <p class="fld__label">Critical-alarm notifications</p>
            <p class="fld__hint">Surface a desktop toast when a critical alarm trips.</p>
          </div>
          <div class="acq__ctl acq__ctl--switch">
            <span class="led" :class="notifyOnCritical ? 'led--crit' : ''"></span>
            <el-switch v-model="notifyOnCritical" />
            <span class="acq__state">{{ notifyOnCritical ? 'ARMED' : 'OFF' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Module 3 · Data sources ────────────────────────────────────── -->
    <section class="mod" :class="{ 'mod--collapsed': collapsed.datasources }">
      <header class="mod__head" @click="collapsed.datasources = !collapsed.datasources">
        <span class="mod__tag">Data sources</span>
        <span class="mod__sub">Saved database connections</span>
        <el-button
          v-if="isAdmin"
          class="mod__action"
          type="primary"
          size="small"
          @click.stop="openCreateDs"
        >
          + Add connection
        </el-button>
        <el-icon class="mod__chevron" :class="{ 'mod__chevron--open': !collapsed.datasources }"><ArrowRight /></el-icon>
      </header>
      <div class="mod__body" v-show="!collapsed.datasources">
        <p v-if="!isAdmin" class="ds__readonly">
          <span class="led"></span> Only administrators can manage connections.
        </p>

        <div v-if="datasources.length" class="conns">
          <div v-for="ds in datasources" :key="ds.id" class="conn">
            <span class="led" :class="rowLed(ds.id)"></span>
            <div class="conn__main">
              <span class="conn__name">
                {{ ds.name }}
                <span class="conn__type">{{ ds.type }}</span>
              </span>
              <span class="conn__dsn">
                {{ ds.username }}@{{ ds.host }}:{{ ds.port }}/{{ ds.database }} · schema={{ ds.db_schema }} · sslmode={{ ds.sslmode }}
              </span>
              <span v-if="rowTest[ds.id]?.message" class="conn__result">{{
                rowTest[ds.id].message
              }}</span>
            </div>
            <div v-if="isAdmin" class="conn__actions">
              <el-button
                size="small"
                :loading="rowTest[ds.id]?.state === 'testing'"
                @click="testRow(ds)"
              >
                Test
              </el-button>
              <el-button size="small" @click="openEditDs(ds)">Edit</el-button>
              <el-button size="small" text type="danger" @click="removeDs(ds)">Delete</el-button>
            </div>
          </div>
        </div>

        <p v-else-if="!dsLoading" class="ds__empty">
          No saved connections yet.
          <template v-if="isAdmin">Add one to make it selectable when editing a Live panel.</template>
        </p>
      </div>
    </section>

    <!-- ── Commit bar (acquisition only) ──────────────────────────────── -->
    <div class="cfg__bar">
      <span class="cfg__barhint">
        Appearance applies instantly. Connections save on their own. Acquisition needs a commit.
      </span>
      <el-button type="primary" :disabled="!dirty" @click="commit">Save changes</el-button>
    </div>

    <!-- ── Connection editor dialog ───────────────────────────────────── -->
    <el-dialog v-model="dialogVisible" :title="dsDialogTitle" width="640px">
      <el-form label-position="top">
        <div class="ds__grid">
          <div class="fld fld--span6">
            <label class="fld__label" for="dsf-name">Name</label>
            <el-input id="dsf-name" v-model="dsForm.name" placeholder="e.g. Plant historian" />
          </div>
          <div class="fld fld--span2">
            <label class="fld__label" for="dsf-type">Type</label>
            <el-select id="dsf-type" v-model="dsForm.type">
              <el-option v-for="o in DS_TYPES" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="dsf-host">Host</label>
            <el-input id="dsf-host" v-model="dsForm.host" placeholder="127.0.0.1" />
          </div>
          <div class="fld">
            <label class="fld__label" for="dsf-port">Port</label>
            <el-input-number
              id="dsf-port"
              v-model="dsForm.port"
              :min="1"
              :max="65535"
              :controls="false"
            />
          </div>
          <div class="fld fld--span2">
            <label class="fld__label" for="dsf-db">Database</label>
            <el-input id="dsf-db" v-model="dsForm.database" placeholder="mml" />
          </div>
          <div class="fld fld--span2">
            <label class="fld__label" for="dsf-schema">Schema</label>
            <el-input id="dsf-schema" v-model="dsForm.db_schema" placeholder="public" />
          </div>
          <div class="fld fld--span2">
            <label class="fld__label" for="dsf-ssl">SSL mode</label>
            <el-select id="dsf-ssl" v-model="dsForm.sslmode">
              <el-option v-for="m in SSL_MODES" :key="m" :label="m" :value="m" />
            </el-select>
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="dsf-user">Username</label>
            <el-input id="dsf-user" v-model="dsForm.username" placeholder="postgres" />
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="dsf-pass">Password</label>
            <el-input
              id="dsf-pass"
              v-model="dsForm.password"
              type="password"
              show-password
              :placeholder="editingHasPassword ? '•••••• (unchanged)' : '••••••••'"
            />
          </div>
        </div>
      </el-form>

      <template #footer>
        <div class="ds-dialog__foot">
          <el-button :loading="dsTest.state === 'testing'" @click="testInDialog">
            Test connection
          </el-button>
          <p class="ds__status" :class="{ 'ds__status--show': dsTest.state !== 'idle' }">
            <span class="led" :class="dsTestLed"></span>
            <span class="ds__msg">{{ dsTest.message }}</span>
          </p>
          <span class="ds-dialog__spacer"></span>
          <el-button @click="dialogVisible = false">Cancel</el-button>
          <el-button type="primary" :loading="savingDs" @click="saveDs">Save</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- Delete connection: small centred confirm dialog (matches LivePage) -->
    <el-dialog
      v-model="deleteDialogVisible"
      title="Delete connection"
      width="420px"
      align-center
      append-to-body
      class="del-dialog"
    >
      <p v-if="deleteTarget" class="del-dialog__msg">
        Delete <strong>{{ deleteTarget.name }}</strong>?
      </p>
      <p class="del-dialog__hint">
        Panels bound to it fall back to the app database. This cannot be undone.
      </p>
      <template #footer>
        <el-button @click="deleteDialogVisible = false">Cancel</el-button>
        <el-button type="danger" :loading="deletingDs" @click="confirmDeleteDs">Delete</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cfg {
  --plate-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 1500px;
  padding-bottom: 88px;
}

/* ── Header ─────────────────────────────────────────────────────────── */
.cfg__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.cfg__eyebrow {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
.cfg__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1;
  color: var(--fg);
}
.cfg__sync {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--fg-muted);
}

/* ── Rack module ────────────────────────────────────────────────────── */
.mod {
  position: relative;
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.mod::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), transparent 65%);
  opacity: 0.7;
}
.mod__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  user-select: none;
}
.mod--collapsed .mod__head {
  border-bottom: none;
}
.mod__tag {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg);
}
.mod__sub {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-dim);
}
.mod__action {
  margin-left: auto;
  align-self: center;
}
.mod__chevron {
  font-size: 13px;
  color: var(--fg-muted);
  flex-shrink: 0;
  transition: transform 0.18s ease;
  transform: rotate(0deg);
}
.mod__chevron--open {
  transform: rotate(90deg);
}
/* Action button pushes chevron to far right; without action button use auto margin */
.mod__head:not(:has(.mod__action)) .mod__chevron {
  margin-left: auto;
}
.mod__body {
  padding: var(--space-5);
}

.fld__label {
  display: block;
  margin: 0 0 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.fld__hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--fg-dim);
}

/* ── Signature: theme faceplates ────────────────────────────────────── */
.plates {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-4);
}
.plate {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--plate-radius);
  cursor: pointer;
  text-align: left;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.plate:hover {
  transform: translateY(-2px);
  border-color: var(--fg-dim);
}
.plate--active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 8px 24px -10px var(--accent);
}
.plate__screen {
  position: relative;
  display: block;
  height: 84px;
  border-radius: 7px;
  padding: 10px;
  overflow: hidden;
}
.plate__win {
  position: relative;
  display: block;
  height: 100%;
  border: 1px solid;
  border-radius: 5px;
  padding: 9px;
}
.plate__accent {
  display: block;
  width: 34px;
  height: 4px;
  border-radius: 2px;
  margin-bottom: 8px;
}
.plate__row {
  display: block;
  width: 70%;
  height: 4px;
  border-radius: 2px;
  margin-bottom: 5px;
  opacity: 0.32;
}
.plate__row--short {
  width: 45%;
  opacity: 0.18;
}
.plate__gauge {
  position: absolute;
  right: 9px;
  bottom: 8px;
  width: 22px;
  height: 22px;
  border: 2px solid;
  border-radius: 50%;
}
.plate__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plate__name {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg);
}
.plate__hex {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-dim);
}
.plate__blurb {
  font-size: 12px;
  color: var(--fg-dim);
}

/* ── Acquisition ────────────────────────────────────────────────────── */
.acq__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}
.acq__row--divider {
  margin-top: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-soft);
}
.acq__label {
  max-width: 360px;
}
.acq__label .fld__label {
  margin-bottom: 0;
}
.acq__ctl {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  justify-content: flex-end;
}
.acq__unit {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-dim);
}
.acq__state {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--fg-muted);
}
.chips {
  display: inline-flex;
  gap: 6px;
}
.chip {
  padding: 5px 11px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}
.chip:hover {
  color: var(--fg);
  border-color: var(--fg-dim);
}
.chip--on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ── Data sources ───────────────────────────────────────────────────── */
.ds__readonly,
.ds__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: var(--fg-dim);
}
.conns {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.conn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.conn__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.conn__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--fg);
}
.conn__type {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-muted);
}
.conn__dsn {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conn__result {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg-muted);
}
.conn__actions {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  align-items: center;
  flex: none;
}

/* form grid shared by the datasource dialog */
.ds__grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: var(--space-4);
}
.fld {
  grid-column: span 6;
  min-width: 0;
}
.fld--span2 {
  grid-column: span 2;
}
.fld--span3 {
  grid-column: span 3;
}
.fld--span6 {
  grid-column: span 6;
}
.fld :deep(.el-input),
.fld :deep(.el-select),
.fld :deep(.el-input-number) {
  width: 100%;
}
.fld :deep(.el-input-number .el-input__inner) {
  text-align: left;
}
.ds__status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.ds__status--show {
  opacity: 1;
}
.ds__msg {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--fg-muted);
}
.ds-dialog__foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}
.ds-dialog__spacer {
  margin-left: auto;
}

/* ── Delete-connection dialog (mirrors LivePage's del-dialog) ─────────── */
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

/* ── Status LEDs ────────────────────────────────────────────────────── */
.led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-dim);
  flex: none;
}
.led--ok {
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
}
.led--warn {
  background: var(--warn);
  box-shadow: 0 0 8px var(--warn);
}
.led--crit {
  background: var(--crit);
  box-shadow: 0 0 8px var(--crit);
}
.led--pulse {
  animation: led-pulse 0.9s ease-in-out infinite;
}
@keyframes led-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ── Commit bar ─────────────────────────────────────────────────────── */
.cfg__bar {
  position: sticky;
  bottom: calc(-1 * var(--space-6));
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-4);
  margin: var(--space-2) calc(-1 * var(--space-6)) calc(-1 * var(--space-6));
  padding: var(--space-4) var(--space-6);
  background: color-mix(in srgb, var(--bg-app) 86%, transparent);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(8px);
}
.cfg__barhint {
  margin-right: auto;
  font-size: 12.5px;
  color: var(--fg-dim);
}

@media (max-width: 720px) {
  .plates {
    grid-template-columns: 1fr;
  }
  .acq__row {
    flex-direction: column;
    gap: var(--space-3);
  }
  .acq__ctl {
    justify-content: flex-start;
  }
  .fld--span2,
  .fld--span3 {
    grid-column: span 6;
  }
  .conn__actions {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .plate,
  .chip,
  .ds__status {
    transition: none;
  }
  .led--pulse {
    animation: none;
  }
}
</style>
