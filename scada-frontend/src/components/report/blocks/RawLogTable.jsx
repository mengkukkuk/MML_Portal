import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import ReportBlock from './ReportBlock'
import { fetchReportLogs } from '@/api/reports'
import { fmtDateTime } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * RawLogTable — the audit trail under the analysis: the actual event_logs rows,
 * unaggregated.
 *
 * Paged server-side rather than filtered from the /run payload, because /run
 * only ever returns *classified* state transitions. A row the vocabulary does
 * not recognise never reaches the charts, and this table is the only place it
 * is visible — which is exactly what someone debugging a suspicious OEE number
 * needs to see.
 */

const SEARCH_DEBOUNCE_MS = 350

export default function RawLogTable({ block, filters }) {
  const pageSize = block?.options?.pageSize ?? 50

  const [offset, setOffset] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any filter or search change invalidates the current page number.
  useEffect(() => {
    setOffset(0)
  }, [search, filters.start, filters.end, filters.locations, filters.tagNames])

  const query = useQuery({
    queryKey: [
      'report', 'logs',
      filters.start, filters.end, filters.locations, filters.tagNames,
      search, pageSize, offset,
    ],
    queryFn: () =>
      fetchReportLogs({
        start: filters.start,
        end: filters.end,
        locations: filters.locations,
        tagNames: filters.tagNames,
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
  const from = total === 0 ? 0 : offset + 1
  const to = offset + rows.length

  return (
    <ReportBlock
      title={block?.title ?? 'Event Log'}
      note={total ? `${total.toLocaleString()} rows` : undefined}
    >
      <TextField
        size="small"
        placeholder="Search event text…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className={styles.search}
      />

      {query.error && (
        <p className={styles.warning}>
          {query.error?.response?.data?.detail || query.error.message}
        </p>
      )}

      {!query.error && rows.length === 0 ? (
        <p className={styles['block__empty']}>
          {query.isLoading ? 'Loading…' : 'No log rows match these filters.'}
        </p>
      ) : (
        <div className={styles['table__scroll']}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Line</th>
                <th>Machine</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id ?? `${r.at_date_time}-${r.tag_name}`}>
                  <td>{fmtDateTime(r.at_date_time)}</td>
                  <td>{r.location ?? '—'}</td>
                  <td>{r.tag_name ?? '—'}</td>
                  <td className={styles['table__wrap']}>{r.event ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pager}>
        <span>
          {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
        </span>
        <div className={styles['pager__buttons']}>
          <Button
            size="small"
            disabled={offset === 0 || query.isFetching}
            onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
          >
            Previous
          </Button>
          <Button
            size="small"
            disabled={to >= total || query.isFetching}
            onClick={() => setOffset((o) => o + pageSize)}
          >
            Next
          </Button>
        </div>
      </div>
    </ReportBlock>
  )
}
