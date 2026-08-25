import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import DownloadOutlined from '@mui/icons-material/DownloadOutlined'
import EditOutlined from '@mui/icons-material/EditOutlined'
import PrintOutlined from '@mui/icons-material/PrintOutlined'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'

import { fetchDefaultTemplate, fetchTemplate, fetchTemplates, runReport } from '@/api/reports'
import { useAuthStore } from '@/stores/auth'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import ReportFilterBar from '@/components/report/ReportFilterBar'
import SourceStatus from '@/components/SourceStatus/SourceStatus'
import {
  DEFAULT_PRESET,
  describeRange,
  filtersFromParams,
  paramsFromFilters,
  resolveRange,
} from '@/components/report/reportRange'
import KpiStrip from '@/components/report/blocks/KpiStrip'
import StateTimeline from '@/components/report/blocks/StateTimeline'
import DowntimePareto from '@/components/report/blocks/DowntimePareto'
import AlarmSummary from '@/components/report/blocks/AlarmSummary'
import SummaryTable from '@/components/report/blocks/SummaryTable'
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
 * unclassified rows, which /run never returns.
 */

const BLOCK_COMPONENTS = {
  kpi: KpiStrip,
  timeline: StateTimeline,
  pareto: DowntimePareto,
  alarms: AlarmSummary,
  summary_table: SummaryTable,
  raw_log: RawLogTable,
}

// Blocks the server can satisfy from a /run call. `raw_log` is absent on
// purpose — it fetches its own pages.
const RUN_BLOCK_TYPES = new Set(['kpi', 'timeline', 'pareto', 'alarms', 'summary_table'])

const WIDTH_CLASS = { full: 'w-full', half: 'w-half', third: 'w-third' }

function errorText(error) {
  if (!error) return ''
  return error?.response?.data?.detail || error?.message || String(error)
}

export default function ReportPage() {
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

  const updateFilters = useCallback(
    (next) => {
      setFilters(next)
      setSearchParams(paramsFromFilters(next), { replace: true })
    },
    [setSearchParams],
  )

  const blocks = useMemo(() => template?.blocks ?? [], [template])

  // Only ask the server for the projections this template actually renders.
  // Dropping 'timeline' alone removes the interval arrays, which are the bulk
  // of the response.
  const runBlocks = useMemo(() => {
    const wanted = blocks.map((b) => b.type).filter((t) => RUN_BLOCK_TYPES.has(t))
    return [...new Set(wanted)]
  }, [blocks])

  const paretoBlock = useMemo(() => blocks.find((b) => b.type === 'pareto'), [blocks])

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
      filters.locations, filters.tagNames, runBlocks,
      paretoBlock?.options?.topN, paretoBlock?.options?.rankBy,
    ],
    queryFn: () =>
      runReport({
        start,
        end,
        locations: filters.locations,
        tagNames: filters.tagNames,
        blocks: runBlocks,
        paretoTopN: paretoBlock?.options?.topN,
        paretoRankBy: paretoBlock?.options?.rankBy,
      }),
    enabled: !!template && !!start && !!end && runBlocks.length > 0,
  })

  const logFilters = useMemo(
    () => ({
      start,
      end,
      locations: filters.locations,
      tagNames: filters.tagNames,
    }),
    [start, end, filters.locations, filters.tagNames],
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
          No report templates exist yet.{' '}
          {isAdmin
            ? 'Create one to get started.'
            : 'Ask an administrator to create one.'}
        </p>
      </div>
    )
  }

  // Canonicalise /reports → /reports/:id so the URL a user shares is stable
  // even if the default flag moves later.
  if (!templateId && defaultQuery.data) {
    const search = searchParams.toString()
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
            <h2 className={styles.title}>{template?.name ?? 'Report'}</h2>
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
            {isAdmin && template && (
              <Button
                size="small"
                startIcon={<EditOutlined />}
                onClick={() => navigate(`/reports/${template.id}/edit`)}
              >
                Edit
              </Button>
            )}
            <Button size="small" startIcon={<PrintOutlined />} onClick={() => window.print()}>
              Print
            </Button>
            <Button
              size="small"
              startIcon={<DownloadOutlined />}
              loading={exporting}
              disabled={!runQuery.data}
              onClick={handleExport}
            >
              Export
            </Button>
          </div>
        </header>

        {/* Printed output loses the interactive controls, so the window it
            covers has to be stated on the page itself. */}
        <p className={styles.range}>
          {describeRange(start, end)}
          <span className={styles.rangeNote}> · plant server local time</span>
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
            its machines then read as "nothing happened" rather than "not
            asked" — a downtime report that quietly omits a line is worse than
            one that fails. */}
        <SourceStatus sources={runQuery.data?.sources} />

        {exportError && <p className={styles.error}>Export failed — {exportError}</p>}

        {runQuery.isLoading && <p className={styles.empty}>Running report…</p>}

        {!blocks.length && template && (
          <p className={styles.empty}>
            This template has no blocks yet.
            {isAdmin ? ' Use Edit to add some.' : ''}
          </p>
        )}

        <div className={styles.grid}>
          {blocks.map((block) => {
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
