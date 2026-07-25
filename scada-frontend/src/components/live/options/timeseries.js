import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { legendCfg, gridTop, timeAxis, valueAxis, tooltipAxis } from './shared'

/**
 * Time series — one line per series, sharing a time x-axis and a
 * zero-baseline value y-axis. Pure function: (seriesList, panelOptions) =>
 * ECharts option. Ported verbatim from LivePanel.vue's timeseriesOption().
 */
export default function buildTimeseriesOption(seriesList, opts = {}) {
  const isMulti = seriesList.length > 1
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(isMulti),
    grid: { top: gridTop(isMulti), right: 14, bottom: 26, left: 46 },
    tooltip: tooltipAxis(seriesList, opts.decimals),
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series: seriesList.map((s, i) => ({
      name: s.label,
      type: 'line',
      smooth: opts.smooth !== false,
      // Show a marker while the series has a single point so the latest
      // reading is visible instantly on refresh; symbols auto-hide once it's
      // a line.
      showSymbol: s.points.length <= 1,
      symbolSize: 6,
      lineStyle: { width: opts.lineWidth || 2, color: colorAt(i) },
      // Skip area fills when overlaying multiple series (muddy when stacked).
      areaStyle: opts.area === false || isMulti ? undefined : { opacity: 0.1, color: colorAt(i) },
      data: s.points,
    })),
  }
}
