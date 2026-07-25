import buildTimeseriesOption from './timeseries'
import buildBarOption from './bar'
import buildBarGaugeOption from './barGauge'
import buildHistogramOption from './histogram'
import buildPieOption from './pie'
import buildHeatmapOption from './heatmap'
import buildScatterOption from './scatter'
import buildStateTimelineOption from './stateTimeline'
import buildCandlestickOption from './candlestick'
import buildGaugeOption, { gaugeParamsFor } from './gauge'
import buildStatSparklineOption from './stat'
import buildTableRows from './table'
import { WARN_COLOR, CRIT_COLOR, thresholdColor, fmtValue } from './shared'

/**
 * vizType -> builder lookup for the 9 "generic" viz types LivePanel renders
 * as a single <EChart> covering every series in one option object. `gauge`,
 * `stat` and `table` are NOT in this map — they render per-series small
 * multiples / a plain MUI table instead of one shared option object, so
 * LivePanel.jsx calls their builders directly (buildGaugeOption per series,
 * buildStatSparklineOption per series, buildTableRows once for the whole
 * table body).
 */
export const GENERIC_BUILDERS = {
  timeseries: buildTimeseriesOption,
  bar: buildBarOption,
  bargauge: buildBarGaugeOption,
  histogram: buildHistogramOption,
  pie: buildPieOption,
  heatmap: buildHeatmapOption,
  scatter: buildScatterOption,
  statetimeline: buildStateTimelineOption,
  candlestick: buildCandlestickOption,
}

export const GENERIC_VIZ_TYPES = new Set(Object.keys(GENERIC_BUILDERS))

// Viz types that show the single-value / chip header row above the chart.
export const HEADER_VALUE_VIZ_TYPES = new Set(['timeseries', 'bar', 'histogram', 'scatter'])

export function buildGenericOption(vizType, seriesList, opts) {
  const builder = GENERIC_BUILDERS[vizType] || buildTimeseriesOption
  return builder(seriesList, opts)
}

export {
  buildGaugeOption,
  gaugeParamsFor,
  buildStatSparklineOption,
  buildTableRows,
  WARN_COLOR,
  CRIT_COLOR,
  thresholdColor,
  fmtValue,
}
