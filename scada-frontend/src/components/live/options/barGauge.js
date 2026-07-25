import { colorAt } from '@/utils/seriesPalette'
import { fmtValue, thresholdColor, TOOLTIP_BASE } from './shared'

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
        color: '#e6edf7',
        fontSize: 12,
        formatter: () => `${fmtValue(v, opts.decimals)}${s.unit ? ' ' + s.unit : ''}`,
      },
    }
  })
  const vAxis = { type: 'value', min, max, axisLabel: { color: '#8a99b3', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } }
  const cAxis = { type: 'category', data: seriesList.map((s) => s.label), axisLabel: { show: isMulti, color: '#8a99b3', fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } }
  return {
    grid: { top: 16, bottom: 24, left: 16, right: 56, containLabel: true },
    tooltip: { ...TOOLTIP_BASE },
    xAxis: vertical ? cAxis : vAxis,
    yAxis: vertical ? vAxis : cAxis,
    series: [{ type: 'bar', barWidth: isMulti ? '55%' : '45%', data }],
  }
}
