import { color as ecColor } from 'echarts'
import { colorAt } from '@/utils/seriesPalette'
import { groupDigits } from '@/utils/numberFormat'
import {
  warnColor, critColor, axisLineColor, tickLineColor, axisTextColor, primaryTextColor,
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
  // A setpoint column's live reading (spec.limits, filled by the poll) beats
  // the typed number; the typed number stays as the fallback for when the
  // column is unset, unreadable, or null on this row.
  const live = spec.limits || {}
  return {
    min: override.min ?? Number(opts.min ?? 0),
    max: override.max ?? Number(opts.max ?? 100),
    decimals: override.decimals ?? opts.decimals,
    warn: live.warn ?? override.warn ?? opts.warn,
    crit: live.crit ?? override.crit ?? opts.crit,
  }
}

/**
 * Which columns (same table, same filter row as the series) supply this
 * series' live warn/crit setpoints. Per-series override first, then the
 * panel-wide binding; null when the limit is manual-only.
 */
export function gaugeLimitColsFor(spec, opts = {}) {
  const override = opts.gaugeSeries?.[spec.unitKey] || {}
  return {
    warnCol: override.warnCol || opts.warnCol || null,
    critCol: override.critCol || opts.critCol || null,
  }
}

const clamp01 = (f) => Math.min(1, Math.max(0, f))

/**
 * Dial band as ECharts axisLine stops. The normal range is a neutral track,
 * never the series colour: the palette contains the same amber/red family as
 * the alarm zones, so a red or amber series used to swallow its own warn/crit
 * bands. Warn only gets a band when it sits below crit — otherwise crit
 * dominates, matching thresholdColor().
 */
export function gaugeBandStops({ min, span, warn, crit }, { track, warnZ, critZ }) {
  const frac = (v) => clamp01((v - min) / span)
  const hasWarn = warn != null && (crit == null || warn < crit)
  if (hasWarn) {
    const stops = [[frac(warn), track]]
    if (crit != null) stops.push([frac(crit), warnZ])
    stops.push([1, crit != null ? critZ : warnZ])
    return stops
  }
  if (crit != null) return [[frac(crit), track], [1, critZ]]
  return [[1, track]]
}

/**
 * Gauge — rendered by the caller as small multiples (one radial gauge per
 * series); this builds ONE series' option. `spec` is a hydrated seriesList
 * entry ({ key, label, unit, unitKey, latest, points, ... }).
 *
 * Drawn as three stacked gauge series sharing one geometry:
 *   1. dial  — neutral track with warn/crit zones, scale and labels
 *   2. limits — a glowing hairline across the band at each warn/crit value
 *   3. needle — the live value; ink-coloured while normal, alarm-coloured
 *      (with glow) once it crosses a limit. The hub keeps the series colour
 *      so each small multiple still matches its label.
 */
export default function buildGaugeOption(spec, index, opts = {}, isMulti = false) {
  const { min, max, decimals, warn, crit } = gaugeParamsFor(spec, opts)
  const span = max - min || 1
  const seriesColor = colorAt(index)
  const warnC = warnColor()
  const critC = critColor()
  const ink = primaryTextColor()
  const val = spec.latest?.value ?? min
  const fmtGauge = (v) => groupDigits(v, decimals)

  const status = (crit != null && val >= crit) ? 'crit'
    : (warn != null && val >= warn) ? 'warn' : 'ok'
  const statusColor = status === 'crit' ? critC : status === 'warn' ? warnC : null

  // Small multiples can shrink to ~84px cells, so thin the ring and use fewer,
  // smaller scale labels there to keep the scale inside the dial.
  const ringWidth = isMulti ? 6 : 10
  const geometry = {
    type: 'gauge', min, max, radius: '92%', center: ['50%', '58%'],
    startAngle: 225, endAngle: -45,
  }
  const bare = {
    axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    axisLabel: { show: false }, progress: { show: false }, anchor: { show: false },
    title: { show: false }, detail: { show: false },
  }

  const dial = {
    ...geometry,
    z: 2,
    silent: true,
    splitNumber: isMulti ? 4 : 10,
    axisLine: {
      lineStyle: {
        width: ringWidth,
        color: gaugeBandStops({ min, span, warn, crit }, {
          track: axisLineColor(),
          warnZ: ecColor.modifyAlpha(warnC, 0.75),
          critZ: ecColor.modifyAlpha(critC, 0.85),
        }),
      },
    },
    progress: { show: false },
    pointer: { show: false },
    axisTick: { show: false },
    splitLine: { length: isMulti ? 6 : 10, distance: 2, lineStyle: { color: tickLineColor(), width: 1 } },
    axisLabel: { color: axisTextColor(), fontSize: isMulti ? 8 : 9, distance: isMulti ? 10 : 14 },
    anchor: { show: false },
    title: { show: false },
    detail: { show: false },
    data: [{ value: val }],
  }

  // Each limit is a pointer pushed out to the rim: inner end at 84% of the
  // radius, outer end just past the ring, so it reads as a lit hairline
  // crossing the band rather than a second needle.
  const limitMark = (value, c) => ({
    value,
    itemStyle: { color: c, shadowColor: c, shadowBlur: isMulti ? 6 : 10 },
  })
  const marks = []
  if (warn != null && warn > min && warn < max && (crit == null || warn < crit)) marks.push(limitMark(warn, warnC))
  if (crit != null && crit > min && crit < max) marks.push(limitMark(crit, critC))

  const limits = marks.length && {
    ...geometry,
    ...bare,
    z: 3,
    silent: true,
    animation: false,
    pointer: {
      show: true, icon: 'rect', keepAspect: false,
      width: isMulti ? 2.5 : 3, length: '20%', offsetCenter: [0, '-84%'],
    },
    data: marks,
  }

  const needle = {
    ...geometry,
    ...bare,
    z: 4,
    pointer: {
      show: true, width: isMulti ? 3 : 4, length: '68%',
      itemStyle: {
        color: statusColor || ink,
        ...(statusColor && { shadowColor: statusColor, shadowBlur: isMulti ? 8 : 12 }),
      },
    },
    anchor: {
      show: true, size: isMulti ? 8 : 11, showAbove: true,
      itemStyle: { color: seriesColor, borderColor: ink, borderWidth: isMulti ? 1.5 : 2 },
    },
    detail: {
      show: true,
      valueAnimation: true,
      formatter: (v) => `${fmtGauge(v)}${spec.unit ? ' ' + spec.unit : ''}`,
      color: statusColor || ink,
      fontSize: isMulti ? 12 : 18,
      fontWeight: 600,
      offsetCenter: [0, '78%'],
    },
    data: [{ value: val }],
  }

  return { series: limits ? [dial, limits, needle] : [dial, needle] }
}
