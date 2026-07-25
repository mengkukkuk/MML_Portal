import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { legendCfg, gridTop, fmtValue, TOOLTIP_BASE } from './shared'

/** Histogram — shared bucket range across every series, one bar set each. */
export default function buildHistogramOption(seriesList, opts = {}) {
  const isMulti = seriesList.length > 1
  const all = seriesList.flatMap((s) => s.points.map((p) => p[1]))
  const n = Math.max(2, Number(opts.buckets ?? 20))
  let lo = Math.min(...all)
  let hi = Math.max(...all)
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) {
    hi = (lo || 0) + 1
    lo = lo || 0
  }
  const width = (hi - lo) / n
  const labels = Array.from({ length: n }, (_, i) => fmtValue(lo + i * width, opts.decimals))
  const series = seriesList.map((s, i) => {
    const counts = new Array(n).fill(0)
    for (const x of s.points.map((p) => p[1])) {
      let bi = Math.floor((x - lo) / width)
      if (bi >= n) bi = n - 1
      if (bi < 0) bi = 0
      counts[bi] += 1
    }
    return { name: s.label, type: 'bar', itemStyle: { color: colorAt(i), borderRadius: [2, 2, 0, 0] }, data: counts }
  })
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(isMulti),
    grid: { top: gridTop(isMulti), right: 14, bottom: 30, left: 40 },
    tooltip: { trigger: 'axis', ...TOOLTIP_BASE },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8a99b3', fontSize: 9, interval: Math.ceil(n / 8) }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
    series,
  }
}
