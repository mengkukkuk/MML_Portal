import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import ReportBlock from './ReportBlock'
import EChart from '@/components/charts/EChart'
import SourceStatus from '@/components/SourceStatus/SourceStatus'
import { fetchSchemaSeries } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { useSettingsStore } from '@/stores/settings'
import { colorAt } from '@/utils/seriesPalette'
import { useTranslation } from '@/i18n'
import { ROLES, VALUE_INDEX, isMultiReading, isPlottable, trendSourceId } from '../trendParams'
import { useQuery } from '@tanstack/react-query'
import { fetchDatasources } from '@/api/datasources'
import { windowError, trendTimeAxis, resolveTrendWindow } from '../trendWindow'
import { useTrendColumns } from '../useTrendColumns'
import useTrendViewport from '../useTrendViewport'
import TrendToolbar, { TrendTouchHint } from '../TrendToolbar'
import { buildDataZoom } from '../trendZoom'
import { formatEvery, trendRefreshMs, windowSpanMs } from '../trendRefresh'
import { readingTitle } from '../readingGroups'
import {
  TILE_BUCKETS, cadenceOf, floorStep, spliceDetail, tierStep, tilesFor,
} from '../trendDetail'
import styles from './blocks.module.css'
import chart from './EnvelopeTrend.module.css'
import { groupDigits } from '@/utils/numberFormat'

/**
 * EnvelopeTrend — one device's reading against its setpoint and limits.
 *
 * Two charts, chosen by how many readings are selected, and they are kept
 * apart on purpose. One reading is an envelope: the question is whether *this*
 * value is inside *its own* band, and the answer is the shape below. Several
 * readings is a comparison, and the roles stop meaning anything across
 * columns — the second reading's limits are not the first one's, and four
 * slots times five readings is twenty lines nobody can read. So a comparison
 * plots the measured slot alone, one line per reading, and the envelope code
 * below is left exactly as it was rather than generalised into something that
 * serves both badly.
 *
 * The envelope is drawn as a strip chart rather than four lines. The limits are
 * the paper the trace is printed on: a band the eye reads as ground, with the
 * setpoint as a fine rule through it, so the measured value is the only
 * saturated ink. Four equal lines would make the reader work out which matters.
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

// Rows per reading per answer — a safety ceiling, not the resolution. What is
// drawn is set by the tier (trendDetail.js): a step from a fixed ladder sized
// to the chart's pixels, bucketed on the epoch, so the same zoom always draws
// the same points. The window is always read whole (`whole`); the server only
// coarsens the step if a tier would not fit under this.
const POINT_BUDGET = 20_000
// A tile is TILE_BUCKETS buckets at up to four rows each.
const TILE_BUDGET = TILE_BUCKETS * 4 + 8

// How long the view has to sit still before the tiles on screen are read.
const DETAIL_SETTLE_MS = 250

// The grid's left + right margins (trendGrid): the plot is this much narrower
// than the block.
const GRID_X = 76

/** The plot's width in pixels, kept current with the block's. */
function usePlotWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => setWidth(Math.max(200, Math.round(el.clientWidth - GRID_X)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

const tileKey = (t) => `${t.step}:${t.from}`

// Past a week the window is rarely full — a table that began logging last month
// fills a sliver of a year's axis — so long windows get a slider to zoom into
// where the data is, beside the wheel/pinch zoom every window has.
const LONG_WINDOW_MS = 7 * 86_400_000

const isLongWindow = (range) => Date.parse(range.end) - Date.parse(range.start) > LONG_WINDOW_MS

const trendGrid = (range) => ({
  left: 56, right: 20, top: 16,
  bottom: isLongWindow(range) ? 48 : 28,
})

const fmt = (n) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', {
    maximumFractionDigits: 3,
  })

/**
 * Every reading normalised to an array, so a table that stores a bare number
 * still plots as a one-role trend instead of throwing on `.length`.
 */
function toPoints(series) {
  return (series?.points ?? []).map((p) => ({
    t: new Date(p.ts).getTime(),
    v: Array.isArray(p.value) ? p.value : [p.value],
  }))
}

/** 3600 → "1 h", 86400 → "1 d": the sampling step, in the note. */
function fmtStep(seconds) {
  if (seconds < 60) return `${seconds} s`
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} d`
  if (seconds >= 3600) return `${Math.round(seconds / 360) / 10} h`
  return `${Math.round(seconds / 60)} min`
}

export default function EnvelopeTrend({ trend, range, onToggleIndex }) {
  const tr = useTranslation()
  const selected = useDatasourceSelectionStore((s) => s.selected)
  // The rail's datasource pick, else the header's first source — see trendSourceId.
  const sourceId = trendSourceId(trend, selected?.[0]?.id)
  const { data: datasources } = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources, staleTime: 60_000 })
  const primary = sourceId == null ? null
    : { id: sourceId, name: datasources?.find((d) => d.id === sourceId)?.name ?? selected?.find((d) => d.id === sourceId)?.name }
  const { groups } = useTrendColumns(trend.table, primary?.id)
  const rangeError = windowError(range.start, range.end)
  const ready = isPlottable(trend) && !rangeError
  const multi = isMultiReading(trend)

  // Live refresh, on the global interval (Settings → Default poll interval). Only
  // a relative window has a "now" to follow; a custom one is a fixed slice of
  // history and re-reading it would change nothing. The interval is stretched on
  // long windows (trendRefresh.js) and the Live control says what it settled on.
  const pollSeconds = useSettingsStore((s) => s.pollSeconds)
  const relative = trend.minutes !== 'custom'
  const [live, setLive] = useState(true)
  const following = live && relative
  const refreshMs = trendRefreshMs(pollSeconds, windowSpanMs(trend))
  // Held by content, not identity: `trend` is re-parsed from the query string
  // on every render pass, so `valueCols` is a different array each time even
  // when the selection has not moved. Everything below keys off this, including
  // an effect that would otherwise fire on a change that never happened.
  const colKey = (trend.valueCols ?? []).join('\u0000')
  const cols = useMemo(() => (colKey ? colKey.split('\u0000') : []), [colKey])

  // Which lines are drawn right now, as opposed to which readings are loaded.
  // The Reading picker decides what this chart is about — changing it refetches
  // — and these decide what is in the way at this moment, which is a different
  // question asked far more often. Deliberately not in the URL: a shared link
  // should carry the readings, and someone who wants to share fewer unticks
  // them rather than sharing a chart with lines silently missing.
  const [hidden, setHidden] = useState([])
  useEffect(() => {
    // A reading unticked and ticked again comes back visible. Holding it hidden
    // would answer a question the reader asked about a different selection.
    setHidden((h) => (h.every((c) => cols.includes(c)) ? h : h.filter((c) => cols.includes(c))))
  }, [cols])

  // One request per reading. /schema/series answers for a single column, and
  // asking it N times keeps each reading independently cached and
  // independently *failable* — a column the plant has since dropped costs its
  // own line, not the whole chart.
  // The tier the whole window is drawn at. Waits for the plot to be measured:
  // the step comes from its width, and guessing would read the window twice.
  const [plotRef, plotPx] = usePlotWidth()
  const windowStep = plotPx
    ? tierStep(Date.parse(range.end) - Date.parse(range.start), plotPx)
    : null

  const query = useQueries({
    queries: cols.map((col) => ({
      // `range` identifies *which* window was asked for (it changes on Apply and
      // on a new binding), not where "now" is: a live refresh re-reads under the
      // same key, so the chart keeps showing the last answer while the next one
      // is on its way instead of blanking every few seconds.
      queryKey: [
        'trend', 'series', primary?.id ?? 'app', trend.table, col,
        trend.tsCol, range.start, range.end, windowStep,
      ],
      queryFn: async ({ signal }) => {
        // A relative window is resolved when the read is made, to the second —
        // the answer carries the window it covers, and the axis follows that.
        const window = relative ? resolveTrendWindow(trend, Date.now(), 1000) : range
        const data = await fetchSchemaSeries({
          table: trend.table,
          valueCol: col,
          tsCol: trend.tsCol,
          start: window.start,
          end: window.end,
          limit: POINT_BUDGET,
          whole: true,
          step: windowStep,
          datasourceId: primary?.id ?? undefined,
          signal,
        })
        return { ...data, window }
      },
      enabled: ready && !!windowStep,
      refetchInterval: following && ready ? refreshMs : false,
    })),
    // Collapsed here rather than in the body: `useQueries` hands back a fresh
    // array every render, and `combine`'s result is structurally memoised, so
    // everything downstream gets a dependency that changes only on new data.
    combine: (results) => ({
      series: results.map((r) => r.data?.series?.[0] ?? null),
      isLoading: results.some((r) => r.isLoading),
      // The first failure is the one reported. Several columns failing is
      // almost always one cause — the table, the window, the connection.
      error: results.find((r) => r.error)?.error ?? null,
      // A window holding more rows than POINT_BUDGET is thinned to a few rows
      // per bucket so the whole of it fits and its spikes survive (schema.py
      // get_series); the step is the same for every column. Unset when every
      // row came back.
      sampled: results.find((r) => r.data?.series?.[0]?.sampled_seconds)?.data?.series?.[0]?.sampled_seconds ?? null,
      sources: results.find((r) => r.data?.sources)?.data?.sources,
      // The window the newest answer covers, and when it landed.
      window: results.find((r) => r.data?.window)?.data?.window ?? null,
      updatedAt: results.reduce((latest, r) => Math.max(latest, r.dataUpdatedAt || 0), 0),
    }),
  })

  // What the axis spans: the window the data was actually read for, which on a
  // live refresh is a little later than the `range` the page resolved once.
  const chartRange = query.window ?? range
  const viewport = useTrendViewport({
    full: { from: Date.parse(chartRange.start), to: Date.parse(chartRange.end) },
    resetKey: [primary?.id ?? 'app', trend.table, colKey, trend.tsCol, range.start, range.end].join('|'),
  })

  // A zoomed view is read again at its own tier, as fixed tiles (trendDetail.js),
  // once it sits still for a moment — a wheel spin or a pan asks once, where it
  // stops. Only when that tier is finer than the window's: otherwise the
  // overview already draws the view as finely as the screen can show.
  const full = { from: Date.parse(chartRange.start), to: Date.parse(chartRange.end) }
  const view = viewport.currentView()
  // Never finer than the rows themselves: learned from the first tile that
  // came back row for row, and kept for this binding.
  const [cadence, setCadence] = useState(null)
  useEffect(() => setCadence(null), [primary?.id, trend.table, trend.tsCol])
  const viewStep = view && plotPx
    ? Math.max(tierStep(view.to - view.from, plotPx), floorStep(cadence))
    : null
  const wanted = view && viewStep && windowStep && viewStep < windowStep
    ? tilesFor(view, full, viewStep)
    : []
  const wantedKey = wanted.map(tileKey).join(',')
  // `tiles` are the ones being read now; `held` are the last set, kept drawn
  // underneath until these land so a tier change never flashes back to the
  // coarse overview.
  const [tiles, setTiles] = useState({ tiles: [], held: [] })
  useEffect(() => {
    const id = setTimeout(() => setTiles((prev) => (
      prev.tiles.map(tileKey).join(',') === wantedKey ? prev
        : { tiles: wanted, held: wanted.length ? prev.tiles : [] }
    )), wanted.length ? DETAIL_SETTLE_MS : 0)
    return () => clearTimeout(id)
    // Keyed by the tiles: `wanted` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey])

  const windowEnd = full.to
  const jobs = useMemo(() => {
    const now = new Set(tiles.tiles.map(tileKey))
    const all = [...tiles.held.filter((t) => !now.has(tileKey(t))), ...tiles.tiles]
    return all.flatMap((tile) => cols.map((col, i) => ({ tile, col, i, current: now.has(tileKey(tile)) })))
  }, [tiles, cols])

  const detail = useQueries({
    queries: jobs.map(({ tile, col }) => {
      // The tile holding "now" keeps growing; every other one is history.
      const growing = tile.to > windowEnd - refreshMs
      return {
        queryKey: [
          'trend', 'tile', primary?.id ?? 'app', trend.table, col, trend.tsCol, tile.step, tile.from,
        ],
        queryFn: async ({ signal }) => {
          const data = await fetchSchemaSeries({
            table: trend.table,
            valueCol: col,
            tsCol: trend.tsCol,
            start: new Date(tile.from).toISOString(),
            end: new Date(tile.to).toISOString(),
            limit: TILE_BUDGET,
            whole: true,
            step: tile.step,
            datasourceId: primary?.id ?? undefined,
            signal,
          })
          return data.series?.[0] ?? null
        },
        enabled: ready,
        staleTime: growing ? 0 : Infinity,
        refetchInterval: following && ready && growing ? refreshMs : false,
      }
    }),
    combine: (results) => results.map((r) => r.data ?? null),
  })

  // Overview, then the held tiles, then the current ones on top — each in
  // place of what it covers.
  const merged = (i) => {
    let out = toPoints(query.series[i])
    jobs.forEach((job, k) => {
      if (job.i === i && detail[k]) out = spliceDetail(out, toPoints(detail[k]), job.tile)
    })
    return out
  }
  const currentTiles = jobs.map((job, k) => (job.current ? detail[k] : null)).filter(Boolean)
  const detailOn = currentTiles.length > 0
  const detailSampled = currentTiles.find((t) => t.sampled_seconds)?.sampled_seconds ?? null
  const rawTile = currentTiles.find((t) => !t.sampled_seconds && t.points?.length > 2)
  useEffect(() => {
    const c = rawTile ? cadenceOf(toPoints(rawTile)) : null
    if (c && cadence == null) setCadence(c)
  }, [rawTile, cadence])

  const series = query.series[0]

  // Empty in a comparison, rather than quietly holding the *first* column's
  // array. Everything below — arity, the roles, the readout — describes one
  // reading's envelope, and there is no such thing here. Emptying it at the
  // source is what makes that structural instead of a guard on each consumer.
  const points = useMemo(
    () => (multi ? [] : merged(0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [multi, series, jobs, detail],
  )

  // One entry per selected reading, for the comparison chart and its key.
  // Colour is positional and the picker preserves order, so a reading keeps
  // its ink as long as the selection around it does.
  const readings = useMemo(
    () => cols.map((col, i) => ({
      col,
      label: readingTitle(groups, col),
      color: colorAt(i),
      points: merged(i),
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cols, groups, query.series, jobs, detail],
  )

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

  // Filtered before the chart is built rather than hidden inside it: a line
  // that is off should cost nothing to draw, and the y-axis should rescale to
  // what is left — the point of switching a reading off is usually that its
  // magnitude was flattening everything else.
  const visible = useMemo(
    () => readings.filter((r) => !hidden.includes(r.col)),
    [readings, hidden],
  )

  // The view is read from the viewport's ref when the option is built, not
  // listed as a dependency: it changes on every gesture and the option must not
  // be rebuilt (and re-applied mid-drag) for it — see useTrendViewport.
  const hand = viewport.hand
  const option = useMemo(() => {
    const dataZoom = buildDataZoom({
      long: isLongWindow(chartRange), view: viewport.currentView(), hand,
    })
    return multi
      ? buildMultiOption(visible, chartRange, dataZoom)
      : buildOption(points, shown, chartRange, tr, dataZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, visible, points, shown, chartRange, tr, hand])

  // Counted over everything loaded, not just what is drawn — otherwise hiding
  // every line would read as "this window has no data", which is a different
  // and much worse thing to tell someone.
  const total = multi
    ? readings.reduce((sum, r) => sum + r.points.length, 0)
    : points.length

  const latest = points.length ? points[points.length - 1] : null
  const note = [
    total ? tr('{count} points', { count: groupDigits(total) }) : null,
    // What the zoomed slice is drawn from when there is one, else the overview.
    detailOn
      ? (detailSampled
        ? tr('min/max per {step}', { step: fmtStep(detailSampled) })
        : tr('every reading in view'))
      : query.sampled ? tr('min/max per {step}', { step: fmtStep(query.sampled) }) : null,
    primary?.name,
  ].filter(Boolean).join(' · ')

  // Named by what the readings have in common when they have something — the
  // camera is the subject and repeating it per line would be five titles.
  const family = groups.find((g) => g.key && cols.every((c) => g.options.some((o) => o.value === c)))
  const title = !cols.length ? tr('Signal trend')
    : multi ? `${family ? `${family.label} · ` : ''}${tr('{count} readings', { count: cols.length })}`
      : readingTitle(groups, cols[0])

  const hasChart = !rangeError && total > 0 && (multi ? visible.length : shown.length) > 0

  const legend = (
    <>
      {multi ? (
        // Same pills, same press state as the envelope's role toggles — the
        // row under this chart's title always means "what is drawn", whichever
        // chart it is. Hiding is local and instant: the readings stay fetched,
        // so switching one back on costs nothing.
        <div className={chart.legend} role="group" aria-label={tr('Readings shown')}>
          {readings.map((r) => (
            <button
              key={r.col}
              type="button"
              className={chart.toggle}
              aria-pressed={!hidden.includes(r.col)}
              onClick={() => setHidden((h) =>
                h.includes(r.col) ? h.filter((c) => c !== r.col) : [...h, r.col])}
            >
              <span className={chart.swatch} style={{ background: r.color }} aria-hidden="true" />
              {r.label}
            </button>
          ))}
        </div>
      ) : available.length > 1 && (
        <div className={chart.legend} role="group" aria-label={tr('Readings shown')}>
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
              {tr(r.label)}
            </button>
          ))}
        </div>
      )}
    </>
  )

  return (
    <ReportBlock title={title} note={note || undefined}>
      <div className={chart.bar} ref={plotRef}>
        <div className={chart.barLegend}>{legend}</div>
        {hasChart && (
          <TrendToolbar
            viewport={viewport}
            live={{
              on: live,
              canFollow: relative,
              every: formatEvery(refreshMs),
              updatedAt: query.updatedAt,
              onToggle: () => setLive((on) => !on),
            }}
          />
        )}
      </div>
      {hasChart && <TrendTouchHint />}

      {query.error && (
        <p className={styles.warning}>
          {query.error?.response?.data?.detail?.error ||
            query.error?.response?.data?.detail ||
            query.error.message}
        </p>
      )}

      <SourceStatus sources={query.sources} />

      {rangeError ? <p className={styles.warning}>{tr(rangeError)}</p> : !total ? (
        <>
        <p className={styles['block__empty']}>
          {query.isLoading
            ? tr('Loading readings…')
            : query.error
              ? tr('No readings to plot.')
              : tr('No readings in this window.')}
        </p>
        <EChart option={option} height="320px" />
        </>
      ) : (multi ? !visible.length : !shown.length) ? (
        // An empty chart frame states nothing and offers nothing. The readings
        // are there; the reader has switched them all off, and the way back is
        // the row of toggles directly above this line.
        <p className={styles['block__empty']}>
          {tr('Every reading is switched off. Turn one on to plot it.')}
        </p>
      ) : (
        <>
          <div className={chart.stage} {...viewport.stageProps}>
            {/* A finger on the chart holds the option back until it lifts, so a
                refresh landing mid-pan or mid-scrub does not tear it down. */}
            <EChart
              option={option}
              height="320px"
              onReady={viewport.onReady}
              hold={viewport.holding}
              onHeldApply={viewport.onHeldApply}
            />
            {viewport.box && (
              <div className={chart.marquee} style={viewport.box} aria-hidden="true" />
            )}
          </div>
          {/* Value, setpoint, deviation — all three are about one reading
              against one band, and there is no such band in a comparison. */}
          {!multi && <Readout latest={latest} shown={shown} />}
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
  const tr = useTranslation()
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
        <dt>{tr('Current')}</dt>
        <dd className={out ? chart.figureOut : chart.figure}>{fmt(value)}</dd>
      </div>
      {setpoint != null && (
        <div className={chart.stat}>
          <dt>{tr('Setpoint')}</dt>
          <dd className={chart.figureQuiet}>{fmt(setpoint)}</dd>
        </div>
      )}
      {deviation != null && (
        <div className={chart.stat}>
          <dt>{tr('Deviation')}</dt>
          <dd className={out ? chart.figureOut : chart.figure}>
            {deviation > 0 ? '+' : ''}{fmt(deviation)}
          </dd>
        </div>
      )}
      {out && <p className={chart.flag}>{tr('Out of tolerance')}</p>}
    </dl>
  )
}

/**
 * The comparison: one line per reading, all on the measured slot.
 *
 * The frame below repeats `buildOption`'s rather than sharing it. That is the
 * deliberate cost of keeping the envelope chart untouched — a shared frame is
 * one edit away from changing a chart this feature was asked not to change.
 */
function buildMultiOption(readings, range, dataZoom) {
  return {
    animation: false,
    grid: trendGrid(range),
    // Still no built-in legend: the key above the chart names the lines, in
    // the same pills the envelope's toggles use.
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
    dataZoom,
    series: readings.map((r) => ({
      name: r.label,
      type: 'line',
      data: r.points.map((p) => {
        const v = p.v[VALUE_INDEX]
        return [p.t, v == null ? null : Number(v)]
      }),
      lineStyle: { color: r.color, width: 2 },
      itemStyle: { color: r.color },
      symbol: r.points.length === 1 ? 'circle' : 'none',
      // Readings are sampled per column; a gap in one is not a gap in the
      // others, and bridging it would draw a measurement nobody took.
      connectNulls: false,
    })),
  }
}

function buildOption(points, shown, range, tr = (text) => text, dataZoom = []) {
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
      name: tr('In tolerance'),
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
  limit('high', 2, tr('High limit'))
  limit('low', 3, tr('Low limit'))

  if (has('setpoint')) {
    series.push({
      name: tr('Setpoint'),
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
      name: tr('Value'),
      type: 'line',
      data: points.map((p, i) => [p.t, v[i]]),
      lineStyle: { color: INK, width: 2 },
      itemStyle: { color: INK },
      symbol: points.length === 1 ? 'circle' : 'none',
      z: 4,
    })

    if (out.some(Boolean)) {
      series.push({
        name: tr('Out of tolerance'),
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
    grid: trendGrid(range),
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
    // Wheel and pinch; the hand tool and the zoom box come from the toolbar. See
    // buildDataZoom for the slider that joins past a week.
    dataZoom,
    series,
  }
}
