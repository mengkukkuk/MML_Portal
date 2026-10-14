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

import { groupDigits, isDigits } from '@/utils/numberFormat'

export const WARN_COLOR = '#e6a23c'
export const CRIT_COLOR = '#f56c6c'

/**
 * Theme-aware chart ink. ECharts draws to <canvas>, which can't resolve a
 * `var(--token)` string the way DOM/CSS can, so every axis/legend/tooltip
 * colour below has to be the *computed* value of the matching design token,
 * read fresh at option-build time rather than cached at module scope. That's
 * what lets a live faceplate swap (`data-theme` on <html>, no reload — see
 * stores/settings.js) repaint charts on their next poll instead of leaving
 * them stuck with whichever theme was active when the module first loaded.
 *
 * Previously these were the `cobalt` theme's literal token values inlined
 * (`#8a99b3`, `rgba(255,255,255,0.12)`, …), which made every chart unreadable
 * on the light `paper` theme (near-white text/gridlines on a near-white
 * panel).
 */
function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export const axisTextColor = () => cssVar('--fg-muted', '#8a99b3')
export const axisLineColor = () => cssVar('--border', 'rgba(255,255,255,0.12)')
export const splitLineColor = () => cssVar('--border-soft', 'rgba(255,255,255,0.06)')
// Gauge ticks/heatmap borders want more ink than the hairline split lines
// above but shouldn't be the primary text colour either.
export const tickLineColor = () => cssVar('--fg-dim', 'rgba(255,255,255,0.25)')
export const primaryTextColor = () => cssVar('--fg', '#e6edf7')
// Theme alarm tokens (paper uses deeper, print-safe tones than the dark
// themes). Distinct from WARN_COLOR/CRIT_COLOR, which double as series-palette
// entries and so can't signal an alarm on a series drawn in the same hue.
export const warnColor = () => cssVar('--warn', '#f59e0b')
export const critColor = () => cssVar('--crit', '#ef4444')

/** Format a raw value for display; `decimals == null` means "as-is".
 *
 * `labels` is the ['OFF', 'ON'] pair a boolean-bound series carries. The
 * column is reported as 0/1 so the chart can draw a step line; this is where
 * that number turns back into the word wherever a single value is *printed*.
 *
 * Guarded on the value rather than trusting the pair: if a column someone
 * bound as a flag later becomes an integer, out-of-range readings print as
 * numbers instead of falling off the end of a two-element array.
 */
export function fmtValue(v, decimals, labels) {
  if (v == null) return '—'
  if (labels && (v === 0 || v === 1)) return labels[v]
  return isDigits(v) ? groupDigits(v, decimals) : `${v}`
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
    ? {
      type: 'scroll', top: 0, itemGap: 8, itemWidth: 9, itemHeight: 9, pageIconSize: 9,
      textStyle: { color: axisTextColor(), fontSize: 10 },
    }
    : undefined
}

export function gridTop(isMulti) {
  return isMulti ? 26 : 8
}

// Tight plot-area insets with containLabel, so axis labels are measured and
// fitted instead of reserving fixed pixel gutters — lets small tiles spend
// almost all their area on the plot itself.
export function compactGrid(top, extra = {}) {
  return { top, right: 10, bottom: 2, left: 2, containLabel: true, ...extra }
}

// Category-axis labels (series names) truncate rather than eat the plot width.
export const CATEGORY_LABEL_WIDTH = 72

export function timeAxis() {
  return {
    type: 'time',
    axisLine: { lineStyle: { color: axisLineColor() } },
    axisLabel: { color: axisTextColor(), fontSize: 10, hideOverlap: true },
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
    axisLabel: { color: axisTextColor(), fontSize: 10, hideOverlap: true },
    splitLine: { lineStyle: { color: splitLineColor() } },
  }
}

// Was a module-level const with hardcoded literals; now a function so each
// tooltip picks up the *current* theme's elevated-surface/text tokens rather
// than whichever theme was active on first import.
export function tooltipBase() {
  const bg = cssVar('--bg-elev', '#172238')
  return { backgroundColor: bg, borderColor: bg, textStyle: { color: primaryTextColor() } }
}

// Axis-trigger tooltip with a per-series unit suffix (valueFormatter can't
// see which series a value belongs to, so the rows are built by hand).
export function tooltipAxis(seriesList, decimals) {
  return {
    trigger: 'axis',
    ...tooltipBase(),
    formatter: (params) => {
      const arr = Array.isArray(params) ? params : [params]
      if (!arr.length) return ''
      const head = arr[0].axisValueLabel || new Date(arr[0].axisValue).toLocaleTimeString()
      const rows = arr.map((p) => {
        const v = Array.isArray(p.value) ? p.value[1] : p.value
        const series = seriesList[p.seriesIndex]
        const u = series?.unit || ''
        return `${p.marker}${p.seriesName}: ${fmtValue(v, decimals, series?.labels)}${u ? ' ' + u : ''}`
      })
      return [head, ...rows].join('<br/>')
    },
  }
}

// --- per-panel text size ---------------------------------------------------
// options.titleSize / options.textSize: a step, not a pixel size, because
// every tile already scales its type off its own box (container queries,
// isMulti-shrunk chart fonts). The step multiplies whatever size that
// responsive logic picked, so a "Large" tile stays proportionate at any size.
export const TEXT_SIZE_STEPS = { S: 0.85, M: 1, L: 1.25, XL: 1.5 }
export const textScaleOf = (step) => TEXT_SIZE_STEPS[step] ?? 1

// Text-bearing ECharts blocks. One without its own fontSize renders at
// ECharts' built-in 12px, so scaling has to supply a size rather than skip it.
const TEXT_BLOCKS = new Set(['axisLabel', 'label', 'textStyle', 'detail', 'nameTextStyle', 'pageTextStyle'])
// ECharts' own defaults: 12px everywhere except tooltip text (14px).
const ECHARTS_DEFAULT_FONT = 12
const ECHARTS_TOOLTIP_FONT = 14

/**
 * Multiply every `fontSize` in an ECharts option by `k` (axis labels, legend,
 * gauge readout, pie labels…), and give text blocks that lean on ECharts'
 * default size an explicit scaled one. Applies to every viz type the same
 * way, since it works on the finished option rather than inside builders.
 * Returns the option unchanged at k === 1 so memoised identities survive for
 * the default size.
 */
export function scaleFonts(option, k) {
  if (!option || k === 1) return option
  const scale = (n) => Math.round(n * k * 10) / 10
  const walk = (v, parentKey, inTooltip) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, parentKey, inTooltip))
    if (!v || typeof v !== 'object') return v
    const out = {}
    for (const [key, val] of Object.entries(v)) {
      // lineHeight scales with the font it boxes, or a fixed line box would
      // clip (or float) larger text.
      out[key] = (key === 'fontSize' || key === 'lineHeight') && typeof val === 'number'
        ? scale(val)
        : walk(val, key, inTooltip || key === 'tooltip')
    }
    if (TEXT_BLOCKS.has(parentKey) && out.fontSize == null) {
      out.fontSize = scale(inTooltip ? ECHARTS_TOOLTIP_FONT : ECHARTS_DEFAULT_FONT)
    }
    return out
  }
  return walk(option, null, false)
}
