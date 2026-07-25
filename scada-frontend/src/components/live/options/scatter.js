import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { legendCfg, gridTop, timeAxis, valueAxis, fmtValue, TOOLTIP_BASE } from './shared'

/** Scatter — individual data points over time, one series per colour. */
export default function buildScatterOption(seriesList, opts = {}) {
  const isMulti = seriesList.length > 1
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(isMulti),
    grid: { top: gridTop(isMulti), right: 14, bottom: 26, left: 46 },
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_BASE,
      formatter: (p) => {
        const u = seriesList[p.seriesIndex]?.unit || ''
        return `${p.seriesName}<br/>${new Date(p.data[0]).toLocaleTimeString()}: ${fmtValue(p.data[1], opts.decimals)}${u ? ' ' + u : ''}`
      },
    },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series: seriesList.map((s, i) => ({
      name: s.label,
      type: 'scatter',
      symbolSize: opts.pointSize ?? 6,
      itemStyle: { color: colorAt(i), opacity: 0.75 },
      data: s.points,
    })),
  }
}
