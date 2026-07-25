import { fmtValue, TOOLTIP_BASE } from './shared'

/** Heatmap — time buckets x series, cell colour = average value in bucket. */
export default function buildHeatmapOption(seriesList, opts = {}) {
  const bucketMs = Math.max(60_000, (opts.bucketMinutes ?? 5) * 60_000)
  const list = seriesList
  if (!list.length) return { series: [] }

  const allTs = list.flatMap((s) => s.points.map((p) => p[0]))
  if (!allTs.length) {
    return {
      xAxis: { type: 'category', data: [] },
      yAxis: { type: 'category', data: list.map((s) => s.label) },
      series: [{ type: 'heatmap', data: [] }],
    }
  }

  const minT = Math.min(...allTs)
  const maxT = Math.max(...allTs)
  const numBuckets = Math.max(1, Math.ceil((maxT - minT) / bucketMs) + 1)
  const timeLabels = Array.from({ length: numBuckets }, (_, i) =>
    new Date(minT + i * bucketMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const seriesLabels = list.map((s) => s.label)

  const heatData = []
  let dataMin = Infinity
  let dataMax = -Infinity
  list.forEach((s, yi) => {
    const bmap = Array.from({ length: numBuckets }, () => [])
    for (const [t, v] of s.points) {
      const bi = Math.min(numBuckets - 1, Math.floor((t - minT) / bucketMs))
      if (bi >= 0 && v != null) bmap[bi].push(v)
    }
    for (let xi = 0; xi < numBuckets; xi++) {
      const vals = bmap[xi]
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length
        heatData.push([xi, yi, avg])
        if (avg < dataMin) dataMin = avg
        if (avg > dataMax) dataMax = avg
      }
    }
  })
  if (!isFinite(dataMin)) dataMin = 0
  if (!isFinite(dataMax)) dataMax = 1

  const vMin = opts.colorMin ?? dataMin
  const vMax = opts.colorMax ?? dataMax

  return {
    tooltip: {
      ...TOOLTIP_BASE,
      formatter: (p) => {
        const [xi, yi, v] = p.data
        const u = seriesList[yi]?.unit || ''
        return `${seriesLabels[yi]}<br/>${timeLabels[xi]}<br/>${v != null ? fmtValue(v, opts.decimals) : '—'}${u ? ' ' + u : ''}`
      },
    },
    grid: { top: 12, right: 60, bottom: 36, left: 80 },
    xAxis: {
      type: 'category', data: timeLabels,
      axisLabel: { color: '#8a99b3', fontSize: 9, interval: Math.ceil(numBuckets / 8), rotate: numBuckets > 10 ? 30 : 0 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
    },
    yAxis: {
      type: 'category', data: seriesLabels,
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    visualMap: {
      min: vMin, max: vMax, calculable: false, orient: 'vertical',
      right: 0, top: 'center',
      textStyle: { color: '#8a99b3', fontSize: 9 },
      inRange: { color: ['#22c55e', '#e6a23c', '#f56c6c'] },
    },
    series: [{ type: 'heatmap', data: heatData, itemStyle: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' } }],
  }
}
