<script setup>
/**
 * EventPage — discrete event log viewer (route: /events).
 * Reads public.event_log via /api/events/recent and renders a
 * location -> tag_name -> events tree: each location is a band, each tag_name a
 * card, each card a timeline of its last N events (newest first).
 * Auto-polls every 30s; the per-card count (5 / 10 / 25) is user-selectable.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { fetchRecentEvents } from '@/api/events'

const POLL_MS = 30_000
const UNKNOWN = 'Unknown'

const events = ref([])
const loading = ref(true)
const error = ref('')
const perCard = ref(10)
const updatedAt = ref(null)
const collapsed = ref(new Set())

let pollTimer = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    events.value = await fetchRecentEvents(perCard.value)
    updatedAt.value = new Date()
  } catch (e) {
    error.value = e?.response?.data?.detail || e?.message || 'Failed to load events.'
  } finally {
    loading.value = false
  }
}

// Fold the flat, pre-ordered list (location, tag_name, at_date_time DESC) into
// a location -> tags -> events tree in a single pass.
const grouped = computed(() => {
  const locations = []
  let curLoc = null
  let curTag = null
  for (const row of events.value) {
    const location = row.location ?? UNKNOWN
    const tagName = row.tag_name ?? UNKNOWN
    if (!curLoc || curLoc.location !== location) {
      curLoc = { location, tags: [], eventCount: 0 }
      locations.push(curLoc)
      curTag = null
    }
    if (!curTag || curTag.tag_name !== tagName) {
      curTag = { tag_name: tagName, events: [] }
      curLoc.tags.push(curTag)
    }
    curTag.events.push(row)
    curLoc.eventCount += 1
  }
  return locations
})

const isEmpty = computed(() => !loading.value && !error.value && grouped.value.length === 0)

const updatedLabel = computed(() =>
  updatedAt.value ? updatedAt.value.toLocaleTimeString() : '—',
)

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

function toggleCard(key) {
  const s = new Set(collapsed.value)
  s.has(key) ? s.delete(key) : s.add(key)
  collapsed.value = s
}

watch(perCard, load)

onMounted(() => {
  load()
  pollTimer = setInterval(load, POLL_MS)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Events</h2>
      <div class="page__controls">
        <span class="evt__updated">
          <span class="evt__dot" :class="{ 'evt__dot--live': !error }" aria-hidden="true" />
          Updated {{ updatedLabel }}
        </span>
        <el-select v-model="perCard" size="default" class="evt__select">
          <el-option :value="5" label="Last 5" />
          <el-option :value="10" label="Last 10" />
          <el-option :value="25" label="Last 25" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>
          <span>Refresh</span>
        </el-button>
      </div>
    </header>

    <p v-if="error" class="page__error">{{ error }}</p>
    <p v-else-if="loading && !events.length" class="page__empty">Loading events…</p>
    <p v-else-if="isEmpty" class="page__empty">No events recorded.</p>

    <section v-for="loc in grouped" :key="loc.location" class="evt__loc">
      <header class="evt__loc-head">
        <span class="evt__loc-name">{{ loc.location }}</span>
        <span class="evt__loc-meta">
          {{ loc.tags.length }} {{ loc.tags.length === 1 ? 'tag' : 'tags' }}
          · {{ loc.eventCount }} {{ loc.eventCount === 1 ? 'event' : 'events' }}
        </span>
      </header>

      <div class="evt__grid">
        <article
          v-for="tag in loc.tags"
          :key="tag.tag_name"
          class="evt__tag"
          :class="{ 'evt__tag--collapsed': collapsed.has(`${loc.location}::${tag.tag_name}`) }"
        >
          <header class="evt__tag-head">
            <span class="evt__tag-name">{{ tag.tag_name }}</span>
            <div class="evt__tag-actions">
              <span class="evt__badge">{{ tag.events.length }}</span>
              <button
                class="evt__minimize"
                :aria-label="collapsed.has(`${loc.location}::${tag.tag_name}`) ? 'Expand' : 'Minimize'"
                @click="toggleCard(`${loc.location}::${tag.tag_name}`)"
              >{{ collapsed.has(`${loc.location}::${tag.tag_name}`) ? '+' : '−' }}</button>
            </div>
          </header>
          <ol v-if="!collapsed.has(`${loc.location}::${tag.tag_name}`)" class="evt__timeline">
            <li
              v-for="(ev, i) in tag.events"
              :key="i"
              class="evt__item"
              :class="{ 'evt__item--latest': i === 0 }"
            >
              <span class="evt__node" aria-hidden="true" />
              <div class="evt__body">
                <span class="evt__text">{{ ev.event ?? '—' }}</span>
                <time class="evt__time">{{ fmtTime(ev.at_date_time) }}</time>
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

.evt__select {
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
.evt__updated {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: 12px;
  font-family: var(--font-mono);
}

.evt__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
}

.evt__dot--live {
  background: var(--ok);
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  animation: evt-pulse 2s infinite;
}

@keyframes evt-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

/* Location band */
.evt__loc {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.evt__loc-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding-left: var(--space-4);
  border-left: 3px solid var(--accent);
}

.evt__loc-name {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg);
}

.evt__loc-meta {
  font-size: 12px;
  color: var(--fg-muted);
}

/* Tag cards */
.evt__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-4);
}

.evt__tag {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}

.evt__tag-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
}

.evt__tag--collapsed .evt__tag-head {
  border-bottom: none;
}

.evt__tag-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.evt__minimize {
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

.evt__minimize:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.evt__tag-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evt__badge {
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

/* Event timeline inside a card */
.evt__timeline {
  list-style: none;
  margin: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.evt__item {
  position: relative;
  padding: 0 0 var(--space-3) var(--space-5);
}

/* The vertical rail connecting the nodes */
.evt__item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: -2px;
  width: 1px;
  background: var(--border);
}

.evt__item:last-child {
  padding-bottom: 0;
}

.evt__item:last-child::before {
  display: none;
}

.evt__node {
  position: absolute;
  left: 0;
  top: 4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 2px solid var(--fg-dim);
}

.evt__item--latest .evt__node {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.evt__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.evt__text {
  font-size: 13px;
  color: var(--fg);
  line-height: 1.4;
}

.evt__time {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--fg-muted);
}
</style>
