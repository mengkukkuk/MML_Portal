import { colorAt } from '@/utils/seriesPalette'
import { WARN_COLOR, CRIT_COLOR, thresholdColor } from './shared'

/**
 * Per-series gauge override: panel.options.gaugeSeries[unitKey] = {min, max,
 * decimals, warn, crit}, set by the admin editor. Any field left unset falls
 * back to the gauge's shared (panel-wide) value, so an override only needs to
 * name what differs for that one series. Uses `??` throughout so an explicit
 * 0 override is honoured and a blank/undefined override falls through
 * instead of coercing to 0.
 */
export function gaugeParamsFor(spec, opts = {}) {
  const override = opts.gaugeSeries?.[spec.unitKey] || {}
  return {
    min: override.min ?? Number(opts.min ?? 0),
    max: override.max ?? Number(opts.max ?? 100),
    decimals: override.decimals ?? opts.decimals,
    warn: override.warn ?? opts.warn,
    crit: override.crit ?? opts.crit,
  }
}

/**
 * Gauge — rendered by the caller as small multiples (one radial gauge per
 * series); this builds ONE series' option. `spec` is a hydrated seriesList
 * entry ({ key, label, unit, unitKey, latest, points, ... }).
 */
export default function buildGaugeOption(spec, index, opts = {}, isMulti = false) {
  const { min, max, decimals, warn, crit } = gaugeParamsFor(spec, opts)
  const span = max - min || 1
  const color = colorAt(index)
  const stops = []
  if (warn != null) stops.push([(warn - min) / span, color])
  if (crit != null) stops.push([(crit - min) / span, warn != null ? WARN_COLOR : color])
  stops.push([1, crit != null ? CRIT_COLOR : (warn != null ? WARN_COLOR : color)])
  const val = spec.latest?.value ?? min
  const pc = thresholdColor(val, color, warn, crit)
  const fmtGauge = (v) => (decimals == null ? `${v}` : Number(v).toFixed(decimals))
  return {
    series: [{
      type: 'gauge', min, max, radius: '92%', center: ['50%', '58%'],
      axisLine: { lineStyle: { width: 10, color: stops } },
      progress: { show: false },
      pointer: { width: 4, itemStyle: { color: pc } },
      axisTick: { show: false },
      splitLine: { length: 10, lineStyle: { color: 'rgba(255,255,255,0.25)' } },
      axisLabel: { color: '#8a99b3', fontSize: 9, distance: 12 },
      anchor: { show: true, size: 8, itemStyle: { color: pc } },
      detail: {
        valueAnimation: true,
        formatter: (v) => `${fmtGauge(v)}${spec.unit ? ' ' + spec.unit : ''}`,
        color: '#e6edf7', fontSize: isMulti ? 14 : 18, offsetCenter: [0, '78%'],
      },
      data: [{ value: val }],
    }],
  }
}
