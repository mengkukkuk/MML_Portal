import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReportBlock from './ReportBlock'
import EChart from '@/components/charts/EChart'
import SourceStatus from '@/components/SourceStatus/SourceStatus'
import { fetchSchemaSeries } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { ROLES, isPlottable } from '../trendParams'
import { windowError, trendTimeAxis } from '../trendWindow'
import styles from './blocks.module.css'
import chart from './EnvelopeTrend.module.css'

/**
 * EnvelopeTrend — one device's reading against its setpoint and limits.
 *
 * Drawn as a strip chart rather than four lines. The limits are the paper the
 * trace is printed on: a band the eye reads as ground, with the setpoint as a
 * fine rule through it, so the measured value is the only saturated ink on the
 * chart. Four equal lines would make the reader work out which one matters.
 *
 * The value line turns red exactly where it leaves the band, which is the one
 * question this chart exists to answer — and it puts excursion *duration* on
 * screen, not just the fact of a crossing.
 *
 * Self-fetching, like RawLogTable: the reading it plots is not part of the OEE
 * /run projection and never will be, so it queries /schema/series directly.
 *
 * Pinned to the primary source. Fanning out would draw one tolerance band per
 * selected plant on top of each other, which is not what "one device" means.
 */

// ECharts paints to canvas and cannot resolve CSS custom properties, so these
// are literal and hand-synced with tokens.css — the same rule reportFormat.js
// documents for every other chart on this page.
const INK = '#3aa0ff'          // --accent: the measured value
const EXCURSION = '#ef4444'    // --crit: the same trace, out of tolerance
const RULE = '#8a99b3'         // --fg-muted: the setpoint
const EDGE = '#3d5170'         // the band's printed edges
const PAPER = 'rgba(58,160,255,0.07)'
const AXIS = '#8a99b3'
const GRIDLINE = 'rgba(255,255,255,0.05)'

const ROLE_COLOR = { value: INK, setpoint: RULE, high: EDGE, low: EDGE }

// Enough resolution for a week at a glance without shipping a plant's whole
// history to the browser. Surfaced as `truncated` when it bites.
const MAX_POINTS = 5000

const fmt = (n) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  })

export default function EnvelopeTrend({ trend, range, onToggleIndex }) {
  const selected = useDatasourceSelectionStore((s) => s.selected)
  const primary = selected?.[0]
  const rangeError = windowError(range.start, range.end)
  const ready = isPlottable(trend) && !rangeError

  const query = useQuery({
    queryKey: [
      'trend', 'series', primary?.id ?? 'app', trend.table, trend.valueCol,
      trend.tsCol, trend.filterCol, trend.filterVal, range.start, range.end,
    ],
    queryFn: () =>
      fetchSchemaSeries({
        table: trend.table,
        valueCol: trend.valueCol,
        tsCol: trend.tsCol,
        filterCol: trend.filterCol || undefined,
        filterVal: trend.filterVal || undefined,
        start: range.start,
        end: range.end,
        limit: MAX_POINTS,
        datasourceId: primary?.id ?? undefined,
      }),
    enabled: ready,
  })

  const series = query.data?.series?.[0]

  // Every reading normalised to an array, so a table that stores a bare number
  // still plots as a one-role trend instead of throwing on `.length`.
  const points = useMemo(() => {
    const raw = series?.points ?? []
    return raw.map((p) => ({
      t: new Date(p.ts).getTime(),
      v: Array.isArray(p.value) ? p.value : [p.value],
    }))
  }, [series])

  // Arity is read off the data, never assumed. Postgres ignores an array's
  // declared length — `float[4]` *is* `float[]` — and this codebase already
  // carries 5-, 6- and 7-slot arrays, with two files disagreeing about one of
  // them. A two-slot reading has to degrade to value + setpoint, not throw.
  const width = useMemo(
    () => points.reduce((m, p) => Math.max(m, p.v.length), 0),
    [points],
  )

  const available = useMemo(() => ROLES.filter((r) => r.index < width), [width])
  const shown = useMemo(
    () => available.filter((r) => trend.indexes.includes(r.index)),
    [available, trend.indexes],
  )
  const isShown = (key) => shown.some((r) => r.key === key)

  const option = useMemo(
    () => buildOption(points, shown, range),
    [points, shown, range],
  )

  const latest = points.length ? points[points.length - 1] : null
  const note = [
    points.length ? `${points.length.toLocaleString()} points` : null,
    series?.truncated ? 'window clipped' : null,
    primary?.name,
  ].filter(Boolean).join(' · ')

  const title = trend.valueCol
    ? `${trend.valueCol}${trend.filterVal ? ` · ${trend.filterVal}` : ''}`
    : 'Signal trend'

  return (
    <ReportBlock title={title} note={note || undefined}>
      {available.length > 1 && (
        <div className={chart.legend} role="group" aria-label="Readings shown">
          {available.map((r) => (
            <button
              key={r.key}
              type="button"
              className={chart.toggle}
              aria-pressed={isShown(r.key)}
              onClick={() => onToggleIndex(r.index)}
            >
              <span
                className={chart.swatch}
                style={{ background: ROLE_COLOR[r.key] }}
                aria-hidden="true"
              />
              {r.label}
            </button>
          ))}
        </div>
      )}

      {query.error && (
        <p className={styles.warning}>
          {query.error?.response?.data?.detail?.error ||
            query.error?.response?.data?.detail ||
            query.error.message}
        </p>
      )}

      <SourceStatus sources={query.data?.sources} />

      {series?.truncated && (
        <p className={styles.warning}>
          Showing the most recent {MAX_POINTS.toLocaleString()} readings. Choose a
          shorter window to see the whole period.
        </p>
      )}

      {rangeError ? <p className={styles.warning}>{rangeError}</p> : !points.length ? (
        <>
        <p className={styles['block__empty']}>
          {query.isLoading
            ? 'Loading readings…'
            : query.error
              ? 'No readings to plot.'
              : 'No readings in this window.'}
        </p>
        <EChart option={option} height="320px" />
        </>
      ) : !shown.length ? (
        // An empty chart frame states nothing and offers nothing. The readings
        // are there; the reader has switched them all off, and the way back is
        // the row of toggles directly above this line.
        <p className={styles['block__empty']}>
          Every reading is switched off. Turn one on to plot it.
        </p>
      ) : (
        <>
          <EChart option={option} height="320px" />
          <Readout latest={latest} shown={shown} />
        </>
      )}
    </ReportBlock>
  )
}

/**
 * The newest reading in words, because the right-hand edge of a week-long chart
 * is a few pixels wide. Deviation is the emphasised figure: it is the one being
 * judged, and it is the only one that is not already on the axis.
 */
function Readout({ latest, shown }) {
  if (!latest) return null
  // Keyed to what is on the chart, not to what the array happens to carry —
  // the toggles decide what this trend is about, and the figures follow them.
  const has = (i) => shown.some((r) => r.index === i)
  const value = has(0) ? latest.v[0] : null
  if (value == null && !has(1)) return null
  const setpoint = has(1) ? latest.v[1] : null
  const deviation =
    value != null && setpoint != null ? value - setpoint : null

  const high = has(2) ? latest.v[2] : null
  const low = has(3) ? latest.v[3] : null
  const out =
    value != null &&
    ((high != null && value > high) || (low != null && value < low))

  return (
    <dl className={chart.readout}>
      <div className={chart.stat}>
        <dt>Current</dt>
        <dd className={out ? chart.figureOut : chart.figure}>{fmt(value)}</dd>
      </div>
      {setpoint != null && (
        <div className={chart.stat}>
          <dt>Setpoint</dt>
          <dd className={chart.figureQuiet}>{fmt(setpoint)}</dd>
        </div>
      )}
      {deviation != null && (
        <div className={chart.stat}>
          <dt>Deviation</dt>
          <dd className={out ? chart.figureOut : chart.figure}>
            {deviation > 0 ? '+' : ''}{fmt(deviation)}
          </dd>
        </div>
      )}
      {out && <p className={chart.flag}>Out of tolerance</p>}
    </dl>
  )
}

function buildOption(points, shown, range) {
  const has = (key) => shown.some((r) => r.key === key)
  const at = (p, i) => (p.v[i] == null ? null : Number(p.v[i]))
  const series = []

  // The band is a *stacked difference*, not two filled areas. Plotting `high`
  // and `low` each as their own area gives two overlapping shapes and no
  // envelope: the lower one paints over the upper. So an invisible floor at
  // `low` carries the stack, and the span above it carries the fill.
  //
  // A null at either limit breaks the stack for that gap, which is honest —
  // there is no band there to draw.
  if (has('high') && has('low')) {
    series.push({
      name: '__floor',
      type: 'line',
      stack: 'band',
      data: points.map((p) => [p.t, at(p, 3)]),
      lineStyle: { opacity: 0 },
      areaStyle: { color: 'transparent' },
      symbol: 'none',
      silent: true,
      tooltip: { show: false },
      z: 1,
    })
    series.push({
      name: 'In tolerance',
      type: 'line',
      stack: 'band',
      data: points.map((p) => {
        const hi = at(p, 2)
        const lo = at(p, 3)
        return [p.t, hi == null || lo == null ? null : hi - lo]
      }),
      lineStyle: { opacity: 0 },
      areaStyle: { color: PAPER },
      symbol: 'none',
      silent: true,
      tooltip: { show: false },
      z: 1,
    })
  }

  // The limits are drawn as their own hairlines rather than as the band's
  // borders, so an edge stays readable when only one of the two is shown and
  // there is no band at all.
  const limit = (roleKey, index, name) => {
    if (!has(roleKey)) return
    series.push({
      name,
      type: 'line',
      data: points.map((p) => [p.t, at(p, index)]),
      lineStyle: { color: EDGE, width: 1 },
      itemStyle: { color: EDGE },
      symbol: points.length === 1 ? 'circle' : 'none',
      z: 2,
    })
  }
  limit('high', 2, 'High limit')
  limit('low', 3, 'Low limit')

  if (has('setpoint')) {
    series.push({
      name: 'Setpoint',
      type: 'line',
      data: points.map((p) => [p.t, at(p, 1)]),
      lineStyle: { color: RULE, width: 1, type: 'dashed' },
      itemStyle: { color: RULE },
      symbol: points.length === 1 ? 'circle' : 'none',
      z: 3,
    })
  }

  // The trace, and the excursions drawn over it in the alarm colour.
  //
  // Two series rather than one recoloured by a visualMap: ECharts only maps line
  // style over the x or y dimension, so the in/out flag — which depends on
  // limits that move per reading — cannot drive it. ("Visual map on line style
  // only support x or y dimension.")
  //
  // The overlay carries each out-of-tolerance reading *and its two neighbours*,
  // which is what keeps it continuous: without them the crossing segments stay
  // blue and the excursion reads as a row of disconnected fragments, exactly
  // where the eye is going. It overstates by one sample at each end, which is
  // the honest direction — the segment leaving the band really is partly out.
  if (has('value')) {
    const v = points.map((p) => at(p, 0))
    // Judged only against the limits currently on the chart. Hiding a limit is
    // a statement about what is being asked, and red against an invisible
    // threshold is an alarm the reader cannot account for.
    const out = points.map((p, i) => {
      const hi = has('high') ? at(p, 2) : null
      const lo = has('low') ? at(p, 3) : null
      return v[i] != null && ((hi != null && v[i] > hi) || (lo != null && v[i] < lo))
    })

    series.push({
      name: 'Value',
      type: 'line',
      data: points.map((p, i) => [p.t, v[i]]),
      lineStyle: { color: INK, width: 2 },
      itemStyle: { color: INK },
      symbol: points.length === 1 ? 'circle' : 'none',
      z: 4,
    })

    if (out.some(Boolean)) {
      series.push({
        name: 'Out of tolerance',
        type: 'line',
        data: points.map((p, i) =>
          [p.t, out[i] || out[i - 1] || out[i + 1] ? v[i] : null]),
        lineStyle: { color: EXCURSION, width: 2 },
        itemStyle: { color: EXCURSION },
        symbol: 'none',
        connectNulls: false,
        // Kept out of the tooltip: it carries the same reading as Value, and
        // listing it twice reads as two measurements. The colour is what says
        // this one is out — the tooltip does not have to say it again.
        tooltip: { show: false },
        z: 5,
      })
    }
  }

  return {
    animation: false,
    grid: { left: 56, right: 20, top: 16, bottom: 28 },
    // No built-in legend: the toggles above the chart are the legend, and a
    // second one would be two controls doing one job.
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#172238',
      borderColor: 'rgba(255,255,255,0.12)',
      textStyle: { color: '#e6edf7', fontSize: 12 },
    },
    xAxis: {
      ...trendTimeAxis(range),
      axisLabel: { color: AXIS, fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: AXIS, fontSize: 10 },
      splitLine: { lineStyle: { color: GRIDLINE } },
    },
    // Scroll and pinch only. A slider would add a second row of chrome to a
    // chart whose whole point is that it reads at a glance.
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    series,
  }
}
