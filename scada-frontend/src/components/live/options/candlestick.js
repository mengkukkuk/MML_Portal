import { SERIES_PALETTE, colorAt } from '@/utils/seriesPalette'
import { legendCfg, gridTop, timeAxis, valueAxis, fmtValue, TOOLTIP_BASE } from './shared'

/** Candlestick — client-side OHLC aggregation into time buckets. */
export default function buildCandlestickOption(seriesList, opts = {}) {
  const isMulti = seriesList.length > 1
  const bucketMs = Math.max(60_000, (opts.bucketMinutes ?? 5) * 60_000)
  const series = seriesList.map((s, i) => {
    const bmap = new Map()
    for (const [t, v] of s.points) {
      const bStart = Math.floor(t / bucketMs) * bucketMs
      if (!bmap.has(bStart)) bmap.set(bStart, [])
      bmap.get(bStart).push(v)
    }
    const data = [...bmap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([t, vals]) => [t, vals[0], vals[vals.length - 1], Math.min(...vals), Math.max(...vals)])
    const col = colorAt(i)
    return {
      name: s.label,
      type: 'candlestick',
      data,
      itemStyle: { color: col, color0: col + '66', borderColor: col, borderColor0: col + '99' },
    }
  })
  return {
    color: SERIES_PALETTE,
    legend: legendCfg(isMulti),
    grid: { top: gridTop(isMulti), right: 14, bottom: 26, left: 46 },
    tooltip: {
      trigger: 'axis',
      ...TOOLTIP_BASE,
      formatter: (params) => {
        if (!Array.isArray(params) || !params.length) return ''
        const t = new Date(params[0].data?.[0]).toLocaleTimeString()
        const lines = params.map((p) => {
          const [, o, c, lo, hi] = p.data ?? []
          return `${p.marker}${p.seriesName}: O:${fmtValue(o, opts.decimals)} H:${fmtValue(hi, opts.decimals)} L:${fmtValue(lo, opts.decimals)} C:${fmtValue(c, opts.decimals)}`
        })
        return [t, ...lines].join('<br/>')
      },
    },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
    series,
  }
}
