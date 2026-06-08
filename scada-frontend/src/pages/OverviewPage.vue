<script setup>
/**
 * OverviewPage — main dashboard landing page (route: /).
 * Displays three sections:
 *   1. KPI row — StatCards for device counts (online/offline/degraded) and
 *      alarm counts (critical / unacknowledged) sourced from Pinia stores.
 *   2. Gauge grid — GaugeTiles for key process values (currently hardcoded
 *      mock values; replace with live store data when API is ready).
 *   3. Trend section — TrendChart showing the last 60 minutes (mock data).
 */
import { onMounted, computed } from 'vue'
import { storeToRefs } from 'pinia'
import StatCard from '@/components/StatCard.vue'
import GaugeTile from '@/components/GaugeTile.vue'
import TrendChart from '@/components/TrendChart.vue'
import { useDevicesStore } from '@/stores/devices'
import { useAlarmsStore } from '@/stores/alarms'

const devices = useDevicesStore()
const alarms = useAlarmsStore()

onMounted(() => {
  devices.load()
  alarms.load()
})

const { onlineCount, degradedCount, offlineCount } = storeToRefs(devices)
const { criticalCount, unacknowledgedCount } = storeToRefs(alarms)

const trendSeries = computed(() => {
  const now = Date.now()
  const points = (offset, amp, base) =>
    Array.from({ length: 60 }, (_, i) => [
      now - (59 - i) * 60_000,
      +(base + amp * Math.sin((i + offset) / 6) + (Math.random() - 0.5) * 2).toFixed(2),
    ])
  return [
    { name: 'Boiler temp (°C)', data: points(0, 8, 78) },
    { name: 'Compressor PSI', data: points(4, 6, 92) },
  ]
})
</script>

<template>
  <div class="overview">
    <section class="overview__kpis" aria-label="Key metrics">
      <StatCard label="Devices online" :value="onlineCount" tone="ok" icon="CircleCheck" />
      <StatCard label="Offline" :value="degradedCount" tone="warn" icon="WarnTriangleFilled" />
      <StatCard label="Degraded" :value="offlineCount" tone="crit" icon="CircleClose" />
      <StatCard label="Critical alarms" :value="criticalCount" tone="crit" icon="WarningFilled" />
      <StatCard label="Unacknowledged" :value="unacknowledgedCount" tone="warn" icon="Bell" />
    </section>

    <section class="overview__grid">
      <GaugeTile title="Boiler temp" :value="78" :min="0" :max="120" unit="°C" />
      <GaugeTile title="Compressor PSI" :value="92" :min="0" :max="150" unit="" />
      <GaugeTile title="Tank 3 level" :value="86" :min="0" :max="100" unit="%" />
    </section>

    <section class="overview__trend">
      <TrendChart title="Last 60 minutes" :series="trendSeries" />
    </section>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.overview__kpis {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-4);
}

.overview__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-4);
}
</style>
