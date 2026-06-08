<script setup>
/**
 * GaugeTile — ECharts arc-gauge card for a single numeric reading.
 * Props: title, value, min (default 0), max (default 100), unit (string suffix).
 * Renders a 220 px canvas gauge with a blue progress arc; no pointer shown.
 * Used on OverviewPage for key process values (temperature, pressure, level).
 */
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { GaugeChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent } from 'echarts/components'

use([CanvasRenderer, GaugeChart, TitleComponent, TooltipComponent])

const props = defineProps({
  title: { type: String, default: '' },
  value: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  unit: { type: String, default: '' },
})

const option = computed(() => ({
  series: [
    {
      type: 'gauge',
      min: props.min,
      max: props.max,
      startAngle: 210,
      endAngle: -30,
      progress: { show: true, width: 14, roundCap: true, itemStyle: { color: '#3aa0ff' } },
      axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(255,255,255,0.08)']] } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      anchor: { show: false },
      title: {
        offsetCenter: [0, '78%'],
        color: '#8a99b3',
        fontSize: 12,
      },
      detail: {
        offsetCenter: [0, '0%'],
        color: '#e6edf7',
        fontSize: 26,
        fontWeight: 600,
        formatter: (v) => `${Math.round(v)}${props.unit}`,
      },
      data: [{ value: props.value, name: props.title }],
    },
  ],
}))
</script>

<template>
  <div class="gauge">
    <VChart class="gauge__chart" :option="option" autoresize />
  </div>
</template>

<style scoped>
.gauge {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: var(--space-3);
  min-height: 220px;
  display: flex;
}
.gauge__chart {
  width: 100%;
  height: 220px;
}
</style>
