import { colorAt } from '@/utils/seriesPalette'
import { fmtValue, TOOLTIP_BASE } from './shared'

const BAND_H = 22

/** State timeline — horizontal Gantt-style bands showing discrete state transitions. */
export default function buildStateTimelineOption(seriesList, opts = {}) {
  const list = seriesList
  if (!list.length) return { series: [] }
  const round = opts.roundValues !== false

  function stateKey(v) {
    return round ? String(Math.round(v ?? 0)) : fmtValue(v, opts.decimals)
  }

  const stateSet = new Set()
  for (const s of list) {
    for (const [, v] of s.points) stateSet.add(stateKey(v))
  }
  const stateList = [...stateSet]
  const stateColors = stateList.map((_, i) => colorAt(i))

  const segments = []
  const now = Date.now()
  const categoryNames = list.map((s) => s.label)

  list.forEach((s, yi) => {
    const pts = s.points
    if (!pts.length) return
    let segStart = pts[0][0]
    let segK = stateKey(pts[0][1])
    for (let i = 1; i < pts.length; i++) {
      const [t, v] = pts[i]
      const k = stateKey(v)
      if (k !== segK) {
        segments.push([segStart, t, yi, stateList.indexOf(segK)])
        segStart = t
        segK = k
      }
    }
    segments.push([segStart, now, yi, stateList.indexOf(segK)])
  })

  return {
    tooltip: {
      ...TOOLTIP_BASE,
      formatter: (p) => {
        if (!Array.isArray(p.data)) return ''
        const [start, end, yi, si] = p.data
        const dur = Math.round((end - start) / 1000)
        const mins = Math.floor(dur / 60)
        const secs = dur % 60
        const durLabel = mins ? `${mins}m ${secs}s` : `${secs}s`
        return `${categoryNames[yi] ?? ''}<br/>State: <b>${stateList[si] ?? '?'}</b><br/>Duration: ${durLabel}`
      },
    },
    grid: { top: 8, right: 14, bottom: 24, left: 80 },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category', data: categoryNames,
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    },
    series: [{
      type: 'custom',
      renderItem(params, api) {
        const startV = api.value(0)
        const endV = api.value(1)
        const catI = api.value(2)
        const si = api.value(3)
        const catLabel = categoryNames[catI]
        const [x0, y0] = api.coord([startV, catLabel])
        const [x1] = api.coord([endV, catLabel])
        return {
          type: 'rect',
          shape: { x: x0, y: y0 - BAND_H / 2, width: Math.max(1, x1 - x0), height: BAND_H, r: 3 },
          style: api.style({ fill: stateColors[si] ?? '#4f8cff', opacity: 0.85 }),
        }
      },
      encode: { x: [0, 1], y: 2 },
      data: segments,
    }],
  }
}
