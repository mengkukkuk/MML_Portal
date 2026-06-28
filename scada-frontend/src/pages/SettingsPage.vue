<script setup>
/**
 * SettingsPage — the control-console for portal-wide parameters (route: /settings).
 * Laid out as rack modules: APPEARANCE (color faceplate), ACQUISITION (poll
 * cadence + alerts), and DATA SOURCE (Grafana-style DB connection). All state
 * lives in the `settings` Pinia store and persists to localStorage. Theme
 * changes apply live; acquisition and datasource are committed via Save.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { useSettingsStore, THEMES } from '@/stores/settings'

const store = useSettingsStore()
const { theme, pollSeconds, notifyOnCritical, datasource, testState, testMessage } =
  storeToRefs(store)

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
const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full']

// --- dirty tracking (theme is excluded — it commits instantly) -------------
const fingerprint = () =>
  JSON.stringify({ p: pollSeconds.value, n: notifyOnCritical.value, d: datasource.value })
const saved = ref('')
onMounted(() => {
  saved.value = fingerprint()
})
const dirty = computed(() => saved.value !== fingerprint())

// Clear a stale connection result the moment the operator edits the config.
watch(
  datasource,
  () => {
    if (testState.value !== 'idle') store.resetTest()
  },
  { deep: true },
)

function pickTheme(id) {
  store.applyTheme(id)
}
function setPoll(seconds) {
  pollSeconds.value = seconds
}
function commit() {
  store.savePrefs()
  store.saveDatasource()
  saved.value = fingerprint()
  ElMessage.success('Settings committed')
}
function testConnection() {
  store.testConnection()
}

const testLed = computed(
  () =>
    ({ idle: '', testing: 'led--warn led--pulse', ok: 'led--ok', error: 'led--crit' })[
      testState.value
    ],
)
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
    <section class="mod">
      <header class="mod__head">
        <span class="mod__tag">Appearance</span>
        <span class="mod__sub">HMI color faceplate</span>
      </header>
      <div class="mod__body">
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
    <section class="mod">
      <header class="mod__head">
        <span class="mod__tag">Acquisition</span>
        <span class="mod__sub">Default polling cadence</span>
      </header>
      <div class="mod__body acq">
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

    <!-- ── Module 3 · Data source ─────────────────────────────────────── -->
    <section class="mod">
      <header class="mod__head">
        <span class="mod__tag">Data source</span>
        <span class="mod__sub">Historian database connection</span>
      </header>
      <div class="mod__body">
        <div class="ds__grid">
          <div class="fld fld--span2">
            <label class="fld__label" for="ds-type">Type</label>
            <el-select id="ds-type" v-model="datasource.type">
              <el-option
                v-for="o in DS_TYPES"
                :key="o.value"
                :label="o.label"
                :value="o.value"
              />
            </el-select>
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="ds-host">Host</label>
            <el-input id="ds-host" v-model="datasource.host" placeholder="127.0.0.1" />
          </div>
          <div class="fld">
            <label class="fld__label" for="ds-port">Port</label>
            <el-input-number
              id="ds-port"
              v-model="datasource.port"
              :min="1"
              :max="65535"
              :controls="false"
            />
          </div>

          <div class="fld fld--span3">
            <label class="fld__label" for="ds-db">Database</label>
            <el-input id="ds-db" v-model="datasource.database" placeholder="mml" />
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="ds-ssl">SSL mode</label>
            <el-select id="ds-ssl" v-model="datasource.sslmode">
              <el-option v-for="m in SSL_MODES" :key="m" :label="m" :value="m" />
            </el-select>
          </div>

          <div class="fld fld--span3">
            <label class="fld__label" for="ds-user">User</label>
            <el-input id="ds-user" v-model="datasource.user" placeholder="postgres" />
          </div>
          <div class="fld fld--span3">
            <label class="fld__label" for="ds-pass">Password</label>
            <el-input
              id="ds-pass"
              v-model="datasource.password"
              type="password"
              show-password
              placeholder="••••••••"
            />
          </div>
        </div>

        <div class="ds__foot">
          <el-button :loading="testState === 'testing'" @click="testConnection">
            Test connection
          </el-button>
          <p class="ds__status" :class="{ 'ds__status--show': testState !== 'idle' }">
            <span class="led" :class="testLed"></span>
            <span class="ds__msg">{{ testMessage }}</span>
          </p>
        </div>
      </div>
    </section>

    <!-- ── Commit bar ─────────────────────────────────────────────────── -->
    <div class="cfg__bar">
      <span class="cfg__barhint">
        Appearance applies instantly. Acquisition &amp; data source need a commit.
      </span>
      <el-button type="primary" :disabled="!dirty" @click="commit">Save changes</el-button>
    </div>
  </div>
</template>

<style scoped>
.cfg {
  --plate-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 860px;
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
/* engraved accent ledge along the top of every module */
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
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-soft);
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
.mod__body {
  padding: var(--space-5);
}

/* shared field label */
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

/* ── Data source ────────────────────────────────────────────────────── */
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
.fld :deep(.el-input),
.fld :deep(.el-select),
.fld :deep(.el-input-number) {
  width: 100%;
}
.fld :deep(.el-input-number .el-input__inner) {
  text-align: left;
}
.ds__foot {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-soft);
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
