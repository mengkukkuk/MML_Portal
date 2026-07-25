/**
 * Shared ECharts option fragments reused by several of the per-viz-type
 * builders in this folder (legend, grid top offset, time/value axes, the
 * axis-trigger tooltip formatter, number formatting, and warn/crit threshold
 * colouring). Factored out to avoid duplicating the same ~6 fragments across
 * 9 "generic" builders — mirrors the shared helper functions living at the
 * top of the original LivePanel.vue (legendCfg/gridTop/timeAxis/valueAxis/
 * tooltipAxis/thColor).
 *
 * Not itself one of the plan's named viz-type builder files; kept out of the
 * vizType -> builder lookup in index.js.
 */

export const WARN_COLOR = '#e6a23c'
export const CRIT_COLOR = '#f56c6c'

/** Format a raw value for display; `decimals == null` means "as-is". */
export function fmtValue(v, decimals) {
  if (v == null) return '—'
  return decimals == null ? `${v}` : Number(v).toFixed(decimals)
}

/**
 * Threshold -> colour. warn/crit are "value >=" cut-offs; falls back to the
 * series' own base colour. warn/crit are read with `!= null` (never `??` or
 * `||`) so a real 0 threshold is honoured and a blank/undefined threshold
 * never coerces into an accidental 0 cut-off.
 */
export function thresholdColor(v, base, warn, crit) {
  if (crit != null && v >= crit) return CRIT_COLOR
  if (warn != null && v >= warn) return WARN_COLOR
  return base
}

export function legendCfg(isMulti) {
  return isMulti
    ? { type: 'scroll', top: 0, textStyle: { color: '#8a99b3', fontSize: 10 }, itemWidth: 10, itemHeight: 10 }
    : undefined
}

export function gridTop(isMulti) {
  return isMulti ? 30 : 12
}

export function timeAxis() {
  return {
    type: 'time',
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
    axisLabel: { color: '#8a99b3', fontSize: 10 },
    splitLine: { show: false },
  }
}

// scale:false -> axis keeps a zero baseline; max is pushed 20% above the
// data's peak so the top series never touches the chart edge.
export function axisMax(v) {
  const m = v.max
  if (m > 0) return Math.round(m * 1.2)
  if (m < 0) return Math.round(m * 0.8) // less negative -> headroom stays above the peak
  return 1 // all-zero fallback
}

export function valueAxis() {
  return {
    type: 'value',
    scale: false,
    max: axisMax,
    axisLine: { show: false },
    axisLabel: { color: '#8a99b3', fontSize: 10 },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
  }
}

export const TOOLTIP_BASE = { backgroundColor: '#172238', borderColor: '#172238', textStyle: { color: '#e6edf7' } }

// Axis-trigger tooltip with a per-series unit suffix (valueFormatter can't
// see which series a value belongs to, so the rows are built by hand).
export function tooltipAxis(seriesList, decimals) {
  return {
    trigger: 'axis',
    ...TOOLTIP_BASE,
    formatter: (params) => {
      const arr = Array.isArray(params) ? params : [params]
      if (!arr.length) return ''
      const head = arr[0].axisValueLabel || new Date(arr[0].axisValue).toLocaleTimeString()
      const rows = arr.map((p) => {
        const v = Array.isArray(p.value) ? p.value[1] : p.value
        const u = seriesList[p.seriesIndex]?.unit || ''
        return `${p.marker}${p.seriesName}: ${fmtValue(v, decimals)}${u ? ' ' + u : ''}`
      })
      return [head, ...rows].join('<br/>')
    },
  }
}
