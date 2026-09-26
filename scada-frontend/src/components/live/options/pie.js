import { colorAt } from '@/utils/seriesPalette'
import { legendCfg, fmtValue, tooltipBase, axisTextColor } from './shared'

/** Pie / donut — latest value per series as proportional slices. */
export default function buildPieOption(seriesList, opts = {}) {
  const isMulti = seriesList.length > 1
  const labelPos = opts.labelPosition || 'outside'
  const inner = opts.donut !== false ? `${opts.innerRadius ?? 50}%` : '0'
  const data = seriesList.map((s, i) => ({
    name: s.label,
    value: s.latest?.value ?? 0,
    itemStyle: { color: colorAt(i) },
  }))
  return {
    tooltip: {
      trigger: 'item',
      ...tooltipBase(),
      formatter: (p) => {
        const u = seriesList[p.dataIndex]?.unit || ''
        return `${p.name}<br/>${fmtValue(p.value, opts.decimals)}${u ? ' ' + u : ''} (${p.percent}%)`
      },
    },
    legend: legendCfg(isMulti),
    series: [{
      type: 'pie',
      radius: [inner, '70%'],
      center: ['50%', isMulti ? '56%' : '52%'],
      data,
      label: {
        show: labelPos !== 'none',
        position: labelPos === 'none' ? 'outside' : labelPos,
        color: axisTextColor(), fontSize: 10,
        formatter: '{b}: {d}%',
        // Keep outside labels inside small tiles instead of clipping at the edge.
        overflow: 'truncate', width: 80,
      },
      labelLine: { length: 6, length2: 6 },
      labelLayout: { hideOverlap: true },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
    }],
  }
}
