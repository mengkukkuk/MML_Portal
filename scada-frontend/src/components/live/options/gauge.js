import { colorAt } from '@/utils/seriesPalette'
import {
  WARN_COLOR, CRIT_COLOR, thresholdColor, tickLineColor, axisTextColor, primaryTextColor,
} from './shared'

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
  // Small multiples can shrink to ~84px cells, so thin the ring and use fewer,
  // smaller scale labels there to keep the scale inside the dial.
  return {
    series: [{
      type: 'gauge', min, max, radius: '92%', center: ['50%', '58%'],
      splitNumber: isMulti ? 4 : 10,
      axisLine: { lineStyle: { width: isMulti ? 6 : 10, color: stops } },
      progress: { show: false },
      pointer: { width: isMulti ? 3 : 4, itemStyle: { color: pc } },
      axisTick: { show: false },
      splitLine: { length: isMulti ? 6 : 10, lineStyle: { color: tickLineColor() } },
      axisLabel: { color: axisTextColor(), fontSize: isMulti ? 8 : 9, distance: isMulti ? 8 : 12 },
      anchor: { show: true, size: isMulti ? 6 : 8, itemStyle: { color: pc } },
      detail: {
        valueAnimation: true,
        formatter: (v) => `${fmtGauge(v)}${spec.unit ? ' ' + spec.unit : ''}`,
        color: primaryTextColor(), fontSize: isMulti ? 12 : 18, offsetCenter: [0, '78%'],
      },
      data: [{ value: val }],
    }],
  }
}
