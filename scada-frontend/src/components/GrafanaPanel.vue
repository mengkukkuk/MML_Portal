<script setup>
/**
 * GrafanaPanel — iframe wrapper for embedding a single Grafana panel.
 * Appends `from`, `to`, `refresh`, and `kiosk` query params to the src URL.
 * A CSS ::after overlay on the wrapper div blocks Grafana's cross-origin
 * hover panel-menu button (top-right corner) since we cannot inject CSS into
 * the iframe directly.
 * Props: src (required), title, height, from, to, refresh.
 */
import { computed } from 'vue'

const props = defineProps({
  // Grafana panel embed URL (from Share → Embed)
  src: { type: String, required: true },
  title: { type: String, default: '' },
  height: { type: [String, Number], default: 300 },
  // Pass extra query params to override time range
  from: { type: String, default: 'now-1h' },
  to: { type: String, default: 'now' },
  // Auto-refresh interval (e.g. '5s', '10s', '30s', false to disable)
  refresh: { type: [String, Boolean], default: '10s' },
})

const frameUrl = computed(() => {
  if (!props.src) return ''
  try {
    const url = new URL(props.src)
    url.searchParams.set('from', props.from)
    url.searchParams.set('to', props.to)
    if (props.refresh) url.searchParams.set('refresh', String(props.refresh))
    // Remove Grafana chrome for clean embed
    url.searchParams.set('kiosk', '')
    return url.toString()
  } catch (e) {
    console.warn('[GrafanaPanel] Invalid src URL:', props.src)
    return ''
  }
})

const frameHeight = computed(() =>
  typeof props.height === 'number' ? `${props.height}px` : props.height || '280px',
)
</script>

<template>
  <div class="gf-panel">
    <div v-if="title" class="gf-panel__title">{{ title }}</div>
    <div class="gf-panel__wrap">
      <iframe
        :src="frameUrl"
        :style="{ height: frameHeight }"
        class="gf-panel__frame"
        frameborder="0"
        allowfullscreen
      />
    </div>
  </div>
</template>

<style scoped>
.gf-panel {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.gf-panel__title {
  padding: var(--space-3) var(--space-4);
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-soft);
}

.gf-panel__wrap {
  position: relative;
}

/* Block Grafana's hover panel-menu button (cross-origin iframe — cannot inject CSS inside) */
.gf-panel__wrap::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 48px;
  height: 48px;
  z-index: 10;
  pointer-events: all;
}

.gf-panel__frame {
  width: 100%;
  border: none;
  display: block;
  min-height: 200px;
  background: transparent;
}
</style>
