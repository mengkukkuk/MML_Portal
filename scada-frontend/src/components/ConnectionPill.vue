<script setup>
import { computed } from 'vue'
import { useConnectionStore } from '@/stores/connection'

const store = useConnectionStore()

const label = computed(() => {
  switch (store.status) {
    case 'connected': return 'Live'
    case 'degraded': return 'Degraded'
    case 'offline': return 'Offline'
    default: return 'Unknown'
  }
})
</script>

<template>
  <div class="pill" :data-status="store.status" role="status" :aria-label="`Connection ${label}`">
    <span class="pill__dot" />
    <span class="pill__text">{{ label }}</span>
  </div>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  font-size: 12px;
  color: var(--fg-muted);
}

.pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-dim);
  box-shadow: 0 0 0 0 currentColor;
}

.pill[data-status='connected'] {
  color: var(--ok);
}
.pill[data-status='connected'] .pill__dot {
  background: var(--ok);
  animation: pulse 2s ease-in-out infinite;
}

.pill[data-status='degraded'] {
  color: var(--warn);
}
.pill[data-status='degraded'] .pill__dot {
  background: var(--warn);
}

.pill[data-status='offline'] {
  color: var(--crit);
}
.pill[data-status='offline'] .pill__dot {
  background: var(--crit);
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
  50%      { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
}
</style>
