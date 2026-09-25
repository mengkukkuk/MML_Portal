import { colorAt } from '@/utils/seriesPalette'
import {
  fmtValue, thresholdColor, tooltipBase, axisTextColor, splitLineColor, primaryTextColor,
} from './shared'

/**
 * Bar gauge — one labelled, coloured bar per series (a "row" per tag),
 * min/max shared across the whole panel (unlike the small-multiples `gauge`
 * viz type, which supports a per-series override via options.gaugeSeries).
 */
export default function buildBarGaugeOption(seriesList, opts = {}) {
  const min = Number(opts.min ?? 0)
  const max = Number(opts.max ?? 100)
  const vertical = opts.orientation === 'vertical'
  const isMulti = seriesList.length > 1
  const data = seriesList.map((s, i) => {
    const v = s.latest?.value ?? min
    return {
      value: v,
      itemStyle: { color: thresholdColor(v, colorAt(i), opts.warn, opts.crit), borderRadius: 4 },
      label: {
        show: true,
        position: vertical ? 'top' : 'right',
        color: primaryTextColor(),
        fontSize: 12,
        formatter: () => `${fmtValue(v, opts.decimals, s.labels)}${s.unit ? ' ' + s.unit : ''}`,
      },
    }
  })
  const vAxis = { type: 'value', min, max, axisLabel: { color: axisTextColor(), fontSize: 10 }, splitLine: { lineStyle: { color: splitLineColor() } } }
  const cAxis = { type: 'category', data: seriesList.map((s) => s.label), axisLabel: { show: isMulti, color: axisTextColor(), fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } }
  return {
    grid: { top: 16, bottom: 24, left: 16, right: 56, containLabel: true },
    tooltip: { ...tooltipBase() },
    xAxis: vertical ? cAxis : vAxis,
    yAxis: vertical ? vAxis : cAxis,
    series: [{ type: 'bar', barWidth: isMulti ? '55%' : '45%', data }],
  }
}
