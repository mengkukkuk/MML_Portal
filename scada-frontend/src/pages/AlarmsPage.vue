<script setup>
/**
 * AlarmsPage — alarm log viewer (route: /alarms).
 * Reads public.alarm_logs via /api/alarms/recent and renders a
 * location -> tag_name -> alarms tree mirroring the Events page, plus
 * per-card severity tinting and an inline Acknowledge button.
 * Auto-polls every 30s; per-card count (5 / 10 / 25) is user-selectable.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useAlarmsStore } from '@/stores/alarms'

const POLL_MS = 30_000
const ACTIVE_POLL_MS = 1_000
const UNKNOWN = 'Unknown'
const SEV_RANK = { critical: 3, warning: 2, info: 1 }

const store = useAlarmsStore()
const { alarms, activeAlarms, loading, error, updatedAt, acking } = storeToRefs(store)
const perCard = ref(10)
const expanded = ref(null) // key of currently open card, null = all collapsed

let pollTimer = null
let activeTimer = null

function reload() {
  // Historical log stack only — active alarms have their own fast poll below.
  store.load(perCard.value)
  store.loadActive()
}

const hasActive = computed(() => activeAlarms.value.length > 0)

const grouped = computed(() => {
  const locations = []
  let curLoc = null
  let curTag = null
  for (const row of alarms.value) {
    const location = row.location ?? UNKNOWN
    const tagName = row.tag_name ?? UNKNOWN
    if (!curLoc || curLoc.location !== location) {
      curLoc = { location, tags: [], alarmCount: 0 }
      locations.push(curLoc)
      curTag = null
    }
    if (!curTag || curTag.tag_name !== tagName) {
      curTag = { tag_name: tagName, alarms: [], severity: 'info', unacked: 0 }
      curLoc.tags.push(curTag)
    }
    curTag.alarms.push(row)
    const sev = row.severity || 'info'
    if ((SEV_RANK[sev] || 0) > (SEV_RANK[curTag.severity] || 0)) {
      curTag.severity = sev
    }
    if (!row.acknowledged) curTag.unacked += 1
    curLoc.alarmCount += 1
  }
  return locations
})

const isEmpty = computed(() => !loading.value && !error.value && grouped.value.length === 0)
const updatedLabel = computed(() => (updatedAt.value ? updatedAt.value.toLocaleTimeString() : '—'))

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

function toggleCard(key) {
  expanded.value = expanded.value === key ? null : key
}

function sevLabel(s) {
  return (s || 'info').toUpperCase()
}

watch(perCard, reload)

onMounted(() => {
  reload()
  pollTimer = setInterval(reload, POLL_MS)
  // Dedicated fast poll so the active-alarm card appears within ~1s of the
  // backend setting variables_tag.alarm_no, independent of the 30s log refresh.
  activeTimer = setInterval(() => store.loadActive(), ACTIVE_POLL_MS)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (activeTimer) clearInterval(activeTimer)
})
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Alarms</h2>
      <div class="page__controls">
        <span class="alm__updated">
          <span class="alm__dot" :class="{ 'alm__dot--live': !error }" aria-hidden="true" />
          Updated {{ updatedLabel }}
        </span>
        <el-select v-model="perCard" size="default" class="alm__select">
          <el-option :value="5" label="Last 5" />
          <el-option :value="10" label="Last 10" />
          <el-option :value="25" label="Last 25" />
        </el-select>
        <el-button :loading="loading" @click="reload">
          <el-icon><Refresh /></el-icon>
          <span>Refresh</span>
        </el-button>
      </div>
    </header>

    <section v-if="hasActive" class="alm__active">
      <header class="alm__active-head">
        <span class="alm__active-dot" aria-hidden="true" />
        <span class="alm__active-title">Active Alarms</span>
        <span class="alm__active-count">{{ activeAlarms.length }} active</span>
      </header>
      <div class="alm__active-grid">
        <article
          v-for="al in activeAlarms"
          :key="`${al.location}::${al.tag_name}::${al.alarm_no}`"
          class="alm__active-card"
          :class="`alm__active-card--${al.severity || 'info'}`"
        >
          <div class="alm__active-card-top">
            <span class="alm__sev-pill" :class="`alm__sev-pill--${al.severity || 'info'}`">
              {{ sevLabel(al.severity) }}
            </span>
            <span class="alm__active-value">{{ al.alarm_value ?? '—' }}</span>
          </div>
          <span class="alm__active-tag">{{ al.tag_name ?? '—' }}</span>
          <span class="alm__active-loc">{{ al.location ?? '—' }}</span>
          <p class="alm__active-msg">{{ al.alarm ?? '—' }}</p>
          <time class="alm__active-time">{{ fmtTime(al.at_date_time) }}</time>
        </article>
      </div>
    </section>

    <p v-if="error" class="page__error">{{ error }}</p>
    <p v-else-if="loading && !alarms.length" class="page__empty">Loading alarms…</p>
    <p v-else-if="isEmpty" class="page__empty">No alarms recorded.</p>

    <section v-for="loc in grouped" :key="loc.location" class="alm__loc">
      <header class="alm__loc-head">
        <span class="alm__loc-name">{{ loc.location }}</span>
        <span class="alm__loc-meta">
          {{ loc.tags.length }} {{ loc.tags.length === 1 ? 'tag' : 'tags' }}
          · {{ loc.alarmCount }} {{ loc.alarmCount === 1 ? 'alarm' : 'alarms' }}
        </span>
      </header>

      <div class="alm__stack">
        <article
          v-for="tag in loc.tags"
          :key="tag.tag_name"
          class="alm__tag"
          :class="[`alm__tag--${tag.severity}`, { 'alm__tag--collapsed': expanded !== `${loc.location}::${tag.tag_name}` }]"
        >
          <header
            class="alm__tag-head"
            @click="toggleCard(`${loc.location}::${tag.tag_name}`)"
          >
            <span class="alm__sev-pill" :class="`alm__sev-pill--${tag.severity}`">
              {{ sevLabel(tag.severity) }}
            </span>
            <span class="alm__tag-name">{{ tag.tag_name }}</span>
            <div class="alm__tag-actions">
              <span v-if="tag.unacked" class="alm__badge alm__badge--unacked" :title="`${tag.unacked} unacknowledged`">
                {{ tag.unacked }}
              </span>
              <span class="alm__badge">{{ tag.alarms.length }}</span>
              <button
                class="alm__minimize"
                :aria-label="expanded === `${loc.location}::${tag.tag_name}` ? 'Minimize' : 'Expand'"
                @click.stop="toggleCard(`${loc.location}::${tag.tag_name}`)"
              >{{ expanded === `${loc.location}::${tag.tag_name}` ? '−' : '+' }}</button>
            </div>
          </header>
          <ol v-if="expanded === `${loc.location}::${tag.tag_name}`" class="alm__timeline">
            <li
              v-for="(al, i) in tag.alarms"
              :key="al.id"
              class="alm__item"
              :class="[`alm__item--${al.severity || 'info'}`, { 'alm__item--latest': i === 0 }]"
            >
              <span class="alm__node" aria-hidden="true" />
              <div class="alm__body">
                <div class="alm__row">
                  <span class="alm__text">{{ al.alarm ?? '—' }}</span>
                  <span
                    v-if="al.acknowledged"
                    class="alm__ack-pill"
                    :title="al.acknowledged_at ? `Acknowledged ${fmtTime(al.acknowledged_at)}` : 'Acknowledged'"
                  >Ack</span>
                  <button
                    v-else
                    class="alm__ack-btn"
                    :disabled="acking.has(al.id)"
                    @click="store.acknowledge(al.id)"
                  >{{ acking.has(al.id) ? '…' : 'Acknowledge' }}</button>
                </div>
                <time class="alm__time">{{ fmtTime(al.at_date_time) }}</time>
              </div>
            </li>
          </ol>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* Active-alarm panel — live status, rendered above the historical log stacks */
.alm__active {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--crit);
  border-radius: var(--radius);
  background: rgba(239, 68, 68, 0.06);
}

.alm__active-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.alm__active-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--crit);
  box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
  animation: alm-active-pulse 1.6s infinite;
}

@keyframes alm-active-pulse {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
  70% { box-shadow: 0 0 0 7px rgba(239, 68, 68, 0); }
  100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
}

.alm__active-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--fg);
}

.alm__active-count {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--crit);
}

.alm__active-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-3);
}

.alm__active-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0) 32%),
    color-mix(in srgb, var(--bg-elev) 70%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  border: 1px solid var(--border-soft);
  border-left-width: 3px;
  border-radius: var(--radius);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 6px 22px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  transition: box-shadow 0.3s ease, transform 0.3s ease;
}

.alm__active-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.5),
    rgba(255, 255, 255, 0.06) 18%,
    rgba(255, 255, 255, 0) 46%
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

.alm__active-card:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 12px 36px rgba(0, 0, 0, 0.5);
}

@media (prefers-reduced-motion: reduce) {
  .alm__active-card { transition: none; }
  .alm__active-card:hover { transform: none; }
}

.alm__active-card--critical { border-left-color: var(--crit); }
.alm__active-card--warning  { border-left-color: var(--warn); }
.alm__active-card--info     { border-left-color: var(--info); }

.alm__active-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.alm__active-value {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--fg);
  letter-spacing: 0.01em;
  /* Lit-LCD halo on the live alarm value. */
  text-shadow: 0 0 16px color-mix(in srgb, var(--accent) 30%, transparent);
}

.alm__active-tag {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alm__active-loc {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--fg-muted);
  letter-spacing: 0.04em;
}

.alm__active-msg {
  margin: var(--space-1) 0 0;
  font-size: 13px;
  color: var(--fg);
  line-height: 1.4;
}

.alm__active-time {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--fg-muted);
}

.page__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.page__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.page__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.alm__select {
  width: 120px;
}

.page__error {
  color: var(--crit);
  margin: 0;
  font-size: 13px;
}

.page__empty {
  color: var(--fg-muted);
  font-size: 14px;
  padding: var(--space-6) 0;
  text-align: center;
}

/* "Updated" indicator with a pulsing live dot */
.alm__updated {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: 12px;
  font-family: var(--font-mono);
}

.alm__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
}

.alm__dot--live {
  background: var(--ok);
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  animation: alm-pulse 2s infinite;
}

@keyframes alm-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

/* Location band */
.alm__loc {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.alm__loc-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding-left: var(--space-4);
  border-left: 3px solid var(--accent);
}

.alm__loc-name {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg);
}

.alm__loc-meta {
  font-size: 12px;
  color: var(--fg-muted);
}

/* Tag cards */
.alm__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Liquid Crystal faceplate — frosted card + specular top rim. Severity is left
   to the coloured left border / pill, so no accent bloom here (would clash with
   crit/warn tints). See LIQCRYS.md. */
.alm__tag {
  position: relative;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0) 32%),
    color-mix(in srgb, var(--bg-elev) 72%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  border: 1px solid var(--border-soft);
  border-left-width: 3px;
  border-radius: var(--radius-lg);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 6px 22px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.alm__tag::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.5),
    rgba(255, 255, 255, 0.06) 18%,
    rgba(255, 255, 255, 0) 46%
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

.alm__tag--critical { border-left-color: var(--crit); }
.alm__tag--warning  { border-left-color: var(--warn); }
.alm__tag--info     { border-left-color: var(--info); }

.alm__tag-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
  user-select: none;
}

.alm__tag--collapsed .alm__tag-head {
  border-bottom: none;
}

.alm__tag-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.alm__tag-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.alm__sev-pill {
  flex: none;
  padding: 2px var(--space-2);
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.06em;
  border-radius: 999px;
  border: 1px solid currentColor;
  line-height: 1.4;
}

.alm__sev-pill--critical { color: var(--crit); background: rgba(239, 68, 68, 0.12); }
.alm__sev-pill--warning  { color: var(--warn); background: rgba(245, 158, 11, 0.12); }
.alm__sev-pill--info     { color: var(--info); background: var(--accent-soft); }

.alm__badge {
  flex: none;
  min-width: 22px;
  padding: 0 var(--space-2);
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
}

.alm__badge--unacked {
  color: var(--crit);
  background: rgba(239, 68, 68, 0.15);
}

.alm__minimize {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.alm__minimize:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* Alarm timeline inside a card */
.alm__timeline {
  list-style: none;
  margin: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.alm__item {
  position: relative;
  padding: 0 0 var(--space-3) var(--space-5);
}

.alm__item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: -2px;
  width: 1px;
  background: var(--border);
}

.alm__item:last-child { padding-bottom: 0; }
.alm__item:last-child::before { display: none; }

.alm__node {
  position: absolute;
  left: 0;
  top: 4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 2px solid var(--fg-dim);
}

.alm__item--critical .alm__node { border-color: var(--crit); }
.alm__item--warning  .alm__node { border-color: var(--warn); }
.alm__item--info     .alm__node { border-color: var(--info); }

.alm__item--latest.alm__item--critical .alm__node {
  background: var(--crit);
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18);
}
.alm__item--latest.alm__item--warning .alm__node {
  background: var(--warn);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
}
.alm__item--latest.alm__item--info .alm__node {
  background: var(--info);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.alm__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.alm__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.alm__text {
  font-size: 13px;
  color: var(--fg);
  line-height: 1.4;
  flex: 1 1 auto;
  min-width: 0;
}

.alm__time {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--fg-muted);
}

.alm__ack-pill {
  flex: none;
  padding: 1px var(--space-2);
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ok);
  background: rgba(34, 197, 94, 0.15);
  border-radius: 999px;
}

.alm__ack-btn {
  flex: none;
  padding: 2px var(--space-3);
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.alm__ack-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--bg-app);
}

.alm__ack-btn:disabled {
  opacity: 0.5;
  cursor: progress;
}
</style>
