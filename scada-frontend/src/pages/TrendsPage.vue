<script setup>
/**
 * TrendsPage — time-series trends page (route: /trends).
 * When VITE_GRAFANA_DASHBOARD_UID is set in .env, renders live GrafanaPanels
 * for each configured panel ID using the d-solo embed URL format.
 * Falls back to a mock ECharts TrendChart when Grafana is not configured.
 * Time range (1h / 6h / 24h) is controlled by a radio-button group and
 * forwarded to both Grafana iframe params and the mock data generator.
 */
import { computed, ref } from 'vue'
import TrendChart from '@/components/TrendChart.vue'
import GrafanaPanel from '@/components/GrafanaPanel.vue'

// Grafana base URL — update after Grafana is installed
const GRAFANA_URL = import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3000'

const range = ref('1h')

// Map time-range buttons to Grafana "from" values
const grafanaFrom = computed(() => ({
  '1h': 'now-1h',
  '6h': 'now-6h',
  '24h': 'now-24h',
}[range.value] ?? 'now-1h')) // fallback prevents literal "undefined" in URL

// Whether Grafana panels are configured (set VITE_GRAFANA_DASHBOARD_UID in .env)
const dashboardUid = import.meta.env.VITE_GRAFANA_DASHBOARD_UID || ''
const dashboardSlug = import.meta.env.VITE_GRAFANA_DASHBOARD_SLUG || dashboardUid

// Build embed URL for a specific panel
// Grafana d-solo URL format: /d-solo/<uid>/<slug>
function panelUrl(panelId) {
  return `${GRAFANA_URL}/d-solo/${dashboardUid}/${dashboardSlug}?orgId=1&panelId=${panelId}`
}

// Fallback mock data (used when Grafana not yet configured)
const series = computed(() => {
  const now = Date.now()
  const lengthByRange = { '1h': 60, '6h': 72, '24h': 96 }
  const stepByRange = { '1h': 60_000, '6h': 5 * 60_000, '24h': 15 * 60_000 }
  const n = lengthByRange[range.value]
  const step = stepByRange[range.value]
  const make = (offset, amp, base) =>
    Array.from({ length: n }, (_, i) => [
      now - (n - 1 - i) * step,
      +(base + amp * Math.sin((i + offset) / 8) + (Math.random() - 0.5) * 2).toFixed(2),
    ])
  return [
    { name: 'Boiler temp (°C)', data: make(0, 8, 78) },
    { name: 'Compressor PSI', data: make(6, 6, 92) },
    { name: 'Tank 3 level (%)', data: make(12, 4, 84) },
  ]
})
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h2 class="page__title">Trends</h2>
      <el-radio-group v-model="range" size="default">
        <el-radio-button label="1h" />
        <el-radio-button label="6h" />
        <el-radio-button label="24h" />
      </el-radio-group>
    </header>

    <!-- Grafana panels (shown when VITE_GRAFANA_DASHBOARD_UID is set) -->
    <template v-if="dashboardUid">
      <div class="grafana-grid">
        <!--GrafanaPanel
          :src="panelUrl(1)"
          title="Boiler Temperature"
          :from="grafanaFrom"
          :height="280"
        /-->
        <GrafanaPanel
          :src="panelUrl(2)"
          title="Compressor Pressure"
          :from="grafanaFrom"
          :height="280"
        />
        <GrafanaPanel
          :src="panelUrl(3)"
          title="Tank Level"
          :from="grafanaFrom"
          :height="280"
        />
        <GrafanaPanel
          :src="panelUrl(4)"
          title="Pump Flow Rate"
          :from="grafanaFrom"
          :height="280"
        />
      </div>
      <GrafanaPanel
        :src="panelUrl(5)"
        title="All Devices Overview"
        :from="grafanaFrom"
        :height="400"
      />
    </template>

    <!-- Fallback: mock chart (shown until Grafana is set up) -->
    <template v-else>
      <el-alert
        title="Grafana not configured"
        description="Set VITE_GRAFANA_URL and VITE_GRAFANA_DASHBOARD_UID in .env to show live panels."
        type="info"
        :closable="false"
        show-icon
      />
      <TrendChart :series="series" height="480px" />
    </template>
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
}

.page__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.grafana-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: var(--space-4);
}
</style>
