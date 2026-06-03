<script setup>
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components'

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent])

const props = defineProps({
  title: { type: String, default: '' },
  series: { type: Array, default: () => [] }, // [{ name, data: [[ts, val], ...] }]
  height: { type: String, default: '280px' },
})

const option = computed(() => ({
  title: props.title
    ? { text: props.title, left: 0, textStyle: { color: '#e6edf7', fontSize: 14, fontWeight: 600 } }
    : undefined,
  grid: { top: 40, right: 16, bottom: 32, left: 48 },
  tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } },
  legend: { top: 8, right: 0, textStyle: { color: '#8a99b3' }, icon: 'roundRect' },
  xAxis: {
    type: 'time',
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
    axisLabel: { color: '#8a99b3' },
    splitLine: { show: false },
  },
  yAxis: {
    type: 'value',
    axisLine: { show: false },
    axisLabel: { color: '#8a99b3' },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
  },
  series: props.series.map((s) => ({
    name: s.name,
    type: 'line',
    smooth: true,
    showSymbol: false,
    lineStyle: { width: 2 },
    areaStyle: { opacity: 0.08 },
    data: s.data,
  })),
}))
</script>

<template>
  <div class="trend">
    <VChart class="trend__chart" :style="{ height }" :option="option" autoresize />
  </div>
</template>

<style scoped>
.trend {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: var(--space-4);
}
.trend__chart {
  width: 100%;
}
</style>
