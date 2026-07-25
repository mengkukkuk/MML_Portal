import { colorAt } from '@/utils/seriesPalette'

/**
 * Stat — the big-number viz is rendered as plain JSX (not an ECharts
 * canvas), but the optional per-series sparkline (single-series stat panels
 * only, `options.sparkline !== false`) is a tiny ECharts line chart. This
 * builds ONE series' sparkline option, mirroring sparklineOptionFor().
 */
export default function buildStatSparklineOption(spec, index) {
  const color = colorAt(index)
  return {
    grid: { top: 4, right: 4, bottom: 4, left: 4 },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', scale: true, show: false },
    series: [{
      type: 'line',
      smooth: true,
      showSymbol: spec.points.length <= 1,
      symbolSize: 5,
      lineStyle: { width: 2, color },
      areaStyle: { opacity: 0.15, color },
      data: spec.points,
    }],
  }
}
