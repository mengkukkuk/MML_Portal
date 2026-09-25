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
      radius: [inner, '72%'],
      center: ['50%', isMulti ? '55%' : '52%'],
      data,
      label: {
        show: labelPos !== 'none',
        position: labelPos === 'none' ? 'outside' : labelPos,
        color: axisTextColor(), fontSize: 11,
        formatter: '{b}: {d}%',
      },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
    }],
  }
}
