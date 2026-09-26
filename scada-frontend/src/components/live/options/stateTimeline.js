import { colorAt } from '@/utils/seriesPalette'
import {
  fmtValue, tooltipBase, axisTextColor, axisLineColor, compactGrid, CATEGORY_LABEL_WIDTH,
} from './shared'

const BAND_H = 22

/** State timeline — horizontal Gantt-style bands showing discrete state transitions. */
export default function buildStateTimelineOption(seriesList, opts = {}) {
  const list = seriesList
  if (!list.length) return { series: [] }
  const round = opts.roundValues !== false

  // A band's key is also its legend entry, so a boolean series' two bands read
  // OFF and ON rather than 0 and 1 -- the viz this matters most on, since a
  // flag over time is exactly what a state timeline is for. Rounding still
  // applies first: the label pair is indexed by the value, not by its text.
  function stateKey(v, labels) {
    if (labels && (v === 0 || v === 1)) return labels[v]
    return round ? String(Math.round(v ?? 0)) : fmtValue(v, opts.decimals)
  }

  const stateSet = new Set()
  for (const s of list) {
    for (const [, v] of s.points) stateSet.add(stateKey(v, s.labels))
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
    let segK = stateKey(pts[0][1], s.labels)
    for (let i = 1; i < pts.length; i++) {
      const [t, v] = pts[i]
      const k = stateKey(v, s.labels)
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
      ...tooltipBase(),
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
    grid: compactGrid(6),
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: axisLineColor() } },
      axisLabel: { color: axisTextColor(), fontSize: 10, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category', data: categoryNames,
      axisLabel: { color: axisTextColor(), fontSize: 10, width: CATEGORY_LABEL_WIDTH, overflow: 'truncate' },
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
        // Shrink bands with the tile: never taller than 70% of a category row.
        const bandH = Math.max(4, Math.min(BAND_H, api.size([0, 1])[1] * 0.7))
        return {
          type: 'rect',
          shape: { x: x0, y: y0 - bandH / 2, width: Math.max(1, x1 - x0), height: bandH, r: 3 },
          style: api.style({ fill: stateColors[si] ?? '#4f8cff', opacity: 0.85 }),
        }
      },
      encode: { x: [0, 1], y: 2 },
      data: segments,
    }],
  }
}
