import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import ReportBlock from './ReportBlock'
import SourceStatus from '@/components/SourceStatus/SourceStatus'
import { fetchReportLogs } from '@/api/reports'
import { useTranslation } from '@/i18n'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { fmtDateTime, fmtNumber, isMultiSource } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * RawLogTable — the audit trail under the analysis: the actual
 * camera_defect_logs rows, unaggregated, one per inspected batch.
 *
 * Paged server-side rather than filtered from the /run payload, because /run
 * only returns roll-ups. Each row's defect_array arrives already named from
 * its camera's `defect_labels` (joined in the plant's own database), so the
 * breakdown reads "Roll NG 3 · Filter NG 1" rather than "[3,1,0,0,0]".
 */

const SEARCH_DEBOUNCE_MS = 350

export default function RawLogTable({ block, filters }) {
  const tr = useTranslation()
  const pageSize = block?.options?.pageSize ?? 50
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const [offset, setOffset] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any filter or search change invalidates the current page number — as does
  // changing the selection, which re-merges the rows into a different order.
  useEffect(() => {
    setOffset(0)
  }, [search, selectionKey, filters.start, filters.end, filters.locations, filters.cameraCodes])

  const query = useQuery({
    queryKey: [
      'report', 'logs', selectionKey,
      filters.start, filters.end, filters.locations, filters.cameraCodes,
      search, pageSize, offset,
    ],
    queryFn: () =>
      fetchReportLogs({
        start: filters.start,
        end: filters.end,
        locations: filters.locations,
        cameraCodes: filters.cameraCodes,
        search: search || undefined,
        limit: pageSize,
        offset,
      }),
    enabled: !!(filters.start && filters.end),
    // Without this the table blanks out on every page turn and the block
    // collapses, jumping the whole page.
    placeholderData: keepPreviousData,
  })

  const data = query.data
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const multi = isMultiSource(rows)
  const from = total === 0 ? 0 : offset + 1
  const to = offset + rows.length

  return (
    <ReportBlock
      title={tr(block?.title ?? 'Defect Batch Log')}
      note={total ? tr('{count} rows', { count: total.toLocaleString() }) : undefined}
    >
      <TextField
        size="small"
        placeholder={tr('Search camera name or code…')}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className={styles.search}
      />

      {query.error && (
        <p className={styles.warning}>
          {query.error?.response?.data?.detail || query.error.message}
        </p>
      )}

      {/* A plant that failed contributes no rows, which on a paged table is
          indistinguishable from a plant that logged nothing. */}
      <SourceStatus sources={data?.sources} />


      {!query.error && rows.length === 0 ? (
        <p className={styles['block__empty']}>
          {query.isLoading ? tr('Loading…') : tr('No log rows match these filters.')}
        </p>
      ) : (
        <div className={styles['table__scroll']}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{tr('Time')}</th>
                {multi && <th>{tr('Source')}</th>}
                <th>{tr('Line')}</th>
                <th>{tr('Camera')}</th>
                <th>{tr('Batch')}</th>
                <th>{tr('Defects by type')}</th>
                <th className={styles['table__num']}>{tr('Total defects')}</th>
              </tr>
            </thead>
            <tbody>
              {/* `r.id` is a per-database serial, so it repeats across plants —
                  the source has to be in the key or React drops a row. */}
              {rows.map((r) => (
                <tr key={`${r.datasource_id ?? ''}:${r.id ?? `${r.created_at}-${r.code}-${r.batch_id}`}`}>
                  <td>{fmtDateTime(r.created_at)}</td>
                  {multi && <td>{r.datasource_name ?? '—'}</td>}
                  <td>{r.location ?? '—'}</td>
                  <td>{r.name ?? r.code ?? '—'}</td>
                  <td>{r.batch_id ?? '—'}</td>
                  <td className={styles['table__wrap']}>
                    {r.defects?.length ? (
                      <div className={styles.chips}>
                        {r.defects.map((d) => (
                          <span key={d.slot} className={styles.chip} title={tr('Slot {slot}', { slot: d.slot })}>
                            {d.defect}<b>{fmtNumber(d.count)}</b>
                          </span>
                        ))}
                      </div>
                    ) : <span className={styles['matrix__none']}>{tr('No defects')}</span>}
                  </td>
                  <td className={styles['table__num']}>{fmtNumber(r.total_defects ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pager}>
        <span>
          {tr('{from}–{to} of {total}', { from: from.toLocaleString(), to: to.toLocaleString(), total: total.toLocaleString() })}
        </span>
        <div className={styles['pager__buttons']}>
          <Button
            size="small"
            disabled={offset === 0 || query.isFetching}
            onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
          >
            {tr('Previous')}
          </Button>
          <Button
            size="small"
            disabled={to >= total || query.isFetching}
            onClick={() => setOffset((o) => o + pageSize)}
          >
            {tr('Next')}
          </Button>
        </div>
      </div>
    </ReportBlock>
  )
}
