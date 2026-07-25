import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { legendCfg, gridTop, timeAxis, valueAxis, tooltipAxis } from './shared'

/** Bar — one bar series per tag/column over a time x-axis. */
export default function buildBarOption(seriesList, opts = {}) {
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
      type: 'bar',
      itemStyle: { color: colorAt(i), borderRadius: [2, 2, 0, 0] },
      data: s.points,
    })),
  }
}
