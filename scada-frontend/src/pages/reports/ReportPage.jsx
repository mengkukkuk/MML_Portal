import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import AddOutlined from '@mui/icons-material/AddOutlined'
import DownloadOutlined from '@mui/icons-material/DownloadOutlined'
import EditOutlined from '@mui/icons-material/EditOutlined'
import PrintOutlined from '@mui/icons-material/PrintOutlined'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'

import { fetchDefaultTemplate, fetchTemplate, fetchTemplates, runReport } from '@/api/reports'
import { useTranslation } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import ReportFilterBar from '@/components/report/ReportFilterBar'
import TrendRail from '@/components/report/TrendRail'
import EnvelopeTrend from '@/components/report/blocks/EnvelopeTrend'
import { resolveTrendWindow } from '@/components/report/trendWindow'
import SourceStatus from '@/components/SourceStatus/SourceStatus'
import {
  DEFAULT_PRESET,
  describeRange,
  filtersFromParams,
  paramsFromFilters,
  resolveRange,
} from '@/components/report/reportRange'
import {
  FILTER_KEYS,
  TREND_KEYS,
  isPlottable,
  mergeParams,
  paramsFromTrend,
  trendFromParams,
} from '@/components/report/trendParams'
import { readStoredTrend, writeStoredTrend } from '@/components/report/trendStorage'
import KpiStrip from '@/components/report/blocks/KpiStrip'
import DefectTrend from '@/components/report/blocks/DefectTrend'
import ThroughputTimeline from '@/components/report/blocks/ThroughputTimeline'
import DefectPareto from '@/components/report/blocks/DefectPareto'
import QualityExceptions from '@/components/report/blocks/QualityExceptions'
import SummaryTable from '@/components/report/blocks/SummaryTable'
import BatchMatrix from '@/components/report/blocks/BatchMatrix'
import DefectGrid from '@/components/report/blocks/DefectGrid'
import RawLogTable from '@/components/report/blocks/RawLogTable'
import styles from './ReportPage.module.css'

/**
 * ReportPage — renders a saved template against a chosen window.
 *
 * Two things are load-bearing here:
 *
 * 1. Filters live in the URL, so a report is a shareable artifact. "Line 2 was
 *    at 71% last Tuesday" is a link, not a screenshot plus instructions.
 * 2. Exactly one /run request backs every block. The server builds each
 *    machine's intervals once and projects them into each block's payload, so
 *    the KPI cards, the Gantt and the table are arithmetically incapable of
 *    disagreeing — which they would if each block fetched independently.
 *
 * The raw-log block is the deliberate exception: it pages server-side against
 * unclassified rows, which /run never returns. The signal trend is the second —
 * it plots a reading straight off a plant table, which /run has no projection
 * for and never will.
 *
 * Both filter sets share one query string, so each writer merges rather than
 * replaces: picking a date range must not silently clear the chart binding.
 *
 * Two readers, two tabs. "QC Summary" is the analyst's page — how many
 * defects, which types, trending which way, which cameras are over threshold.
 * "Engineering" is where a finding gets chased down — batch by batch, camera
 * by camera, slot by slot, down to the raw log rows. A block's tab follows
 * from its type (BLOCK_TAB), so every saved template splits the same way; the
 * template still decides which blocks exist and their order within a tab. The
 * tab is in the URL (?tab=engineering) like everything else a link should
 * reproduce, and only the open tab is mounted — the raw log's paging query
 * never runs for someone who only reads the summary.
 */

const BLOCK_COMPONENTS = {
  kpi: KpiStrip,
  defect_trend: DefectTrend,
  timeline: ThroughputTimeline,
  pareto: DefectPareto,
  exceptions: QualityExceptions,
  summary_table: SummaryTable,
  batch_matrix: BatchMatrix,
  defect_grid: DefectGrid,
  raw_log: RawLogTable,
}

const TABS = [
  { key: 'summary', label: 'QC Summary' },
  { key: 'engineering', label: 'Engineering' },
]

const BLOCK_TAB = {
  kpi: 'summary',
  defect_trend: 'summary',
  pareto: 'summary',
  exceptions: 'summary',
  summary_table: 'summary',
  batch_matrix: 'engineering',
  defect_grid: 'engineering',
  timeline: 'engineering',
  raw_log: 'engineering',
}

// Blocks the server can satisfy from a /run call. `raw_log` is absent on
// purpose — it fetches its own pages.
const RUN_BLOCK_TYPES = new Set([
  'kpi', 'defect_trend', 'timeline', 'pareto', 'exceptions', 'summary_table',
  'batch_matrix', 'defect_grid',
])

const WIDTH_CLASS = { full: 'w-full', half: 'w-half', third: 'w-third' }

function errorText(error) {
  if (!error) return ''
  return error?.response?.data?.detail || error?.message || String(error)
}

export default function ReportPage() {
  const tr = useTranslation()
  const { templateId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const templatesQuery = useQuery({
    queryKey: ['report', 'templates'],
    queryFn: fetchTemplates,
    staleTime: 60_000,
  })

  // Without an id in the path, fall through to whichever template is flagged
  // default so /reports is always a working link.
  const defaultQuery = useQuery({
    queryKey: ['report', 'template', 'default'],
    queryFn: fetchDefaultTemplate,
    enabled: !templateId,
  })

  const templateQuery = useQuery({
    queryKey: ['report', 'template', templateId],
    queryFn: () => fetchTemplate(templateId),
    enabled: !!templateId,
  })

  const template = templateId ? templateQuery.data : defaultQuery.data

  const [filters, setFilters] = useState(() =>
    filtersFromParams(searchParams, DEFAULT_PRESET),
  )

  // The template's saved preset is the starting point, but only until the URL
  // says otherwise — an explicit ?preset= in a shared link must win.
  useEffect(() => {
    const fallback = template?.default_filters?.preset
    if (!fallback || searchParams.has('preset')) return
    setFilters((f) => ({ ...f, preset: fallback }))
  }, [template, searchParams])

  const [trend, setTrend] = useState(() => trendFromParams(searchParams))

  // A binding to fall back on when the URL carries none — arriving at /reports
  // from the sidebar, or reopening the app. Read once, on the first render, so
  // a later clear can't be undone by the restore firing again.
  const storedTrend = useMemo(
    () => (TREND_KEYS.some((k) => searchParams.has(k)) ? null : readStoredTrend()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const restored = useRef(false)

  // Restored *into the URL*, not into state: the sync effect below rewrites
  // `trend` from the query string on every render pass, so a state-only restore
  // would be stomped before it ever reached the rail.
  useEffect(() => {
    if (restored.current || !storedTrend) return
    restored.current = true
    setSearchParams(
      (curr) => mergeParams(curr, paramsFromTrend(storedTrend), TREND_KEYS),
      { replace: true },
    )
  }, [storedTrend, setSearchParams])

  const [windowRevision, setWindowRevision] = useState(0)
  const trendRange = useMemo(() => resolveTrendWindow(trend),
    [trend.minutes, trend.start, trend.end, windowRevision])

  useEffect(() => {
    setTrend(trendFromParams(searchParams))
    const next = filtersFromParams(searchParams, template?.default_filters?.preset ?? DEFAULT_PRESET)
    setFilters((current) => paramsFromFilters(current).toString() === paramsFromFilters(next).toString()
      ? current : next)
  }, [searchParams, template?.default_filters?.preset])

  const updateFilters = useCallback(
    (next) => {
      setFilters(next)
      setSearchParams(
        (curr) => mergeParams(curr, paramsFromFilters(next), FILTER_KEYS),
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const updateTrend = useCallback(
    (next) => {
      setTrend(next)
      writeStoredTrend(next)
      setSearchParams(
        (curr) => mergeParams(curr, paramsFromTrend(next), TREND_KEYS),
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const toggleIndex = useCallback(
    (index) =>
      updateTrend({
        ...trend,
        indexes: trend.indexes.includes(index)
          ? trend.indexes.filter((i) => i !== index)
          : [...trend.indexes, index].sort((a, b) => a - b),
      }),
    [trend, updateTrend],
  )

  const applyWindow = useCallback((patch) => {
    setWindowRevision((n) => n + 1)
    updateTrend({ ...trend, ...patch,
      start: patch.minutes === 'custom' ? patch.start : '',
      end: patch.minutes === 'custom' ? patch.end : '',
    })
  }, [trend, updateTrend])

  const blocks = useMemo(() => template?.blocks ?? [], [template])

  const tab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'summary'
  const setTab = useCallback((next) => {
    setSearchParams((curr) => {
      const out = new URLSearchParams(curr)
      if (next === 'summary') out.delete('tab')
      else out.set('tab', next)
      return out
    }, { replace: true })
  }, [setSearchParams])
  const tabBlocks = useMemo(
    () => blocks.filter((b) => (BLOCK_TAB[b.type] ?? 'summary') === tab),
    [blocks, tab],
  )
  const tabCounts = useMemo(() => {
    const counts = { summary: 0, engineering: 0 }
    blocks.forEach((b) => { if (BLOCK_COMPONENTS[b.type]) counts[BLOCK_TAB[b.type] ?? 'summary'] += 1 })
    return counts
  }, [blocks])

  // Only ask the server for the projections this template actually renders.
  // Dropping 'timeline' and 'defect_trend' skips the per-period read, and
  // 'batch_matrix' the camera_batch_work read. Both tabs' blocks are asked for
  // at once, so switching tabs is instant rather than a second report run.
  const runBlocks = useMemo(() => {
    const wanted = blocks.map((b) => b.type).filter((t) => RUN_BLOCK_TYPES.has(t))
    return [...new Set(wanted)]
  }, [blocks])

  const paretoBlock = useMemo(() => blocks.find((b) => b.type === 'pareto'), [blocks])
  const exceptionsBlock = useMemo(() => blocks.find((b) => b.type === 'exceptions'), [blocks])

  // Resolved once per run so every block and the export share one window —
  // re-resolving 'last7d' per consumer would hand them slightly different ends.
  const [start, end] = useMemo(
    () => resolveRange(filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.preset, filters.start, filters.end],
  )

  const runQuery = useQuery({
    queryKey: [
      'report', 'run', template?.id, selectionKey,
      start?.valueOf(), end?.valueOf(),
      filters.locations, filters.cameraCodes, runBlocks,
      paretoBlock?.options?.topN, paretoBlock?.options?.rankBy,
      exceptionsBlock?.options?.warnPct, exceptionsBlock?.options?.critPct,
      exceptionsBlock?.options?.topN,
    ],
    queryFn: () =>
      runReport({
        start,
        end,
        locations: filters.locations,
        cameraCodes: filters.cameraCodes,
        blocks: runBlocks,
        paretoTopN: paretoBlock?.options?.topN,
        paretoRankBy: paretoBlock?.options?.rankBy,
        exceptionsWarnPct: exceptionsBlock?.options?.warnPct,
        exceptionsCritPct: exceptionsBlock?.options?.critPct,
        exceptionsTopN: exceptionsBlock?.options?.topN,
      }),
    enabled: !!template && !!start && !!end && runBlocks.length > 0,
  })

  const logFilters = useMemo(
    () => ({
      start,
      end,
      locations: filters.locations,
      cameraCodes: filters.cameraCodes,
    }),
    [start, end, filters.locations, filters.cameraCodes],
  )

  async function handleExport() {
    setExportError('')
    setExporting(true)
    try {
      // ExcelJS is ~700 kB and only ever runs on this click — importing it
      // lazily keeps it off the report's initial page load.
      const { exportReportXlsx } = await import('@/utils/reportExport')
      await exportReportXlsx({
        result: runQuery.data,
        filters: logFilters,
        templateName: template?.name,
        rangeLabel: describeRange(start, end),
        tr,
      })
    } catch (e) {
      setExportError(errorText(e))
    } finally {
      setExporting(false)
    }
  }

  // No templates exist at all — seeding failed or an admin deleted every one.
  if (!templateId && defaultQuery.isError) {
    return (
      <div className={styles.page}>
        <p className={styles.error}>
          {tr('No report templates exist yet.')}{' '}
          {isAdmin ? tr('Create one to get started.') : tr('Ask an administrator to create one.')}
        </p>
        {isAdmin && (
          <Button size="small" variant="contained" onClick={() => navigate('/reports/new')}>
            {tr('Create template')}
          </Button>
        )}
      </div>
    )
  }

  // Canonicalise /reports → /reports/:id so the URL a user shares is stable
  // even if the default flag moves later.
  if (!templateId && defaultQuery.data) {
    const search = (storedTrend
      ? mergeParams(searchParams, paramsFromTrend(storedTrend), TREND_KEYS)
      : searchParams
    ).toString()
    return (
      <Navigate
        to={`/reports/${defaultQuery.data.id}${search ? `?${search}` : ''}`}
        replace
      />
    )
  }

  const loadError = templateQuery.error || defaultQuery.error
  const runError = runQuery.error
  const templates = templatesQuery.data ?? []

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div className={`${styles.page} report-root`}>
        <header className={`${styles.head} report-controls`}>
          <div className={styles['head__left']}>
            <h2 className={styles.title}>{template?.name ?? tr('Report')}</h2>
            {templates.length > 1 && (
              <FormControl size="small" className={styles.templateSelect}>
                <Select
                  value={template?.id ?? ''}
                  onChange={(e) =>
                    navigate(`/reports/${e.target.value}?${searchParams.toString()}`)
                  }
                >
                  {templates.map((t) => (
                    <MenuItem key={t.id} value={t.id}>
                      {t.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
          </div>

          <div className={styles['head__right']}>
            {isAdmin && (
              <Button size="small" startIcon={<AddOutlined />} onClick={() => navigate('/reports/new')}>
                {tr('New')}
              </Button>
            )}
            {isAdmin && template && (
              <Button
                size="small"
                startIcon={<EditOutlined />}
                onClick={() => navigate(`/reports/${template.id}/edit`)}
              >
                {tr('Edit')}
              </Button>
            )}
            <Button size="small" startIcon={<PrintOutlined />} onClick={() => window.print()}>
              {tr('Print')}
            </Button>
            <Button
              size="small"
              startIcon={<DownloadOutlined />}
              loading={exporting}
              disabled={!runQuery.data}
              onClick={handleExport}
            >
              {tr('Export')}
            </Button>
          </div>
        </header>

        <Tabs
          value={tab}
          onChange={(_e, next) => setTab(next)}
          className={`${styles.tabs} report-controls`}
          aria-label={tr('Report view')}
        >
          {TABS.map((t) => (
            <Tab
              key={t.key}
              value={t.key}
              label={(
                <span className={styles.tabLabel}>
                  {tr(t.label)}
                  <span className={styles.tabCount}>{tabCounts[t.key]}</span>
                </span>
              )}
            />
          ))}
        </Tabs>

        {/* The signal trend leads the summary and is bound separately: it reads
            a plant table directly, on its own window (up to a year), and
            answers a different question from the report blocks below it. Its
            controls lead because the chart under them has nothing to draw
            until they are filled in. */}
        {tab === 'summary' && (
          <section className={styles.trend} aria-label={tr('Signal trend')}>
            <TrendRail trend={trend} range={trendRange} onApplyWindow={applyWindow} onChange={updateTrend} />
            {isPlottable(trend) ? (
              <EnvelopeTrend trend={trend} range={trendRange} onToggleIndex={toggleIndex} />
            ) : (
              <p className={styles.empty}>
                {tr('Pick a table, a reading and a timestamp above to plot a signal.')}
              </p>
            )}
          </section>
        )}

        {/* Printed output loses the interactive controls, so the window it
            covers has to be stated on the page itself. This one describes the
            report blocks below, not the trend — so it sits with its own filters. */}
        <p className={styles.range}>
          {tr(TABS.find((t) => t.key === tab).label)} · {describeRange(start, end)}
          <span className={styles.rangeNote}> · {tr('plant server local time')}</span>
        </p>

        <ReportFilterBar
          filters={filters}
          onChange={updateFilters}
          onRefresh={() => runQuery.refetch()}
          isFetching={runQuery.isFetching}
        />

        {template?.description && <p className={styles.desc}>{template.description}</p>}

        {loadError && <p className={styles.error}>{errorText(loadError)}</p>}
        {runError && <p className={styles.error}>{errorText(runError)}</p>}

        {/* A plant that failed to answer drops out of the report entirely, and
            its cameras then read as "nothing happened" rather than "not
            asked" — a defect report that quietly omits a line is worse than
            one that fails. */}
        <SourceStatus sources={runQuery.data?.sources} />

        {exportError && <p className={styles.error}>{tr('Export failed')} — {exportError}</p>}

        {runQuery.isLoading && <p className={styles.empty}>{tr('Running report…')}</p>}

        {!blocks.length && template && (
          <p className={styles.empty}>
            {tr('This template has no blocks yet.')}
            {isAdmin ? ` ${tr('Use Edit to add some.')}` : ''}
          </p>
        )}
        {!!blocks.length && !tabBlocks.length && (
          <p className={styles.empty}>
            {tr('This template has no blocks on this tab.')}
            {isAdmin ? ` ${tr('Use Edit to add some.')}` : ''}
          </p>
        )}

        <div className={styles.grid}>
          {tabBlocks.map((block) => {
            const Component = BLOCK_COMPONENTS[block.type]
            if (!Component) return null
            const isLog = block.type === 'raw_log'
            // Every other block is a projection of the single /run result and
            // has nothing to draw until it arrives.
            if (!isLog && !runQuery.data) return null
            return (
              <div
                key={block.id}
                className={styles[WIDTH_CLASS[block.width] ?? 'w-full']}
              >
                <Component
                  block={block}
                  result={runQuery.data}
                  filters={logFilters}
                />
              </div>
            )
          })}
        </div>
      </div>
    </LocalizationProvider>
  )
}
