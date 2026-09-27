import { useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import {
  cameraKey,
  cameraLabel,
  defectRateColor,
  fmtDateTime,
  fmtNumber,
  fmtPercent,
  isMultiSource,
  STATUS_COLORS,
  STATUS_LABELS,
} from '../reportFormat'
import styles from './blocks.module.css'

/**
 * SummaryTable — one row per camera, plus a totals footer.
 *
 * Defects, batches, worst defect and last seen are camera_defect_logs figures;
 * inspected (and so the rate) is production_hourly_log's and reads "—" where
 * the source has no such table. The footer comes from the server's `totals`,
 * which sums counts rather than averaging the rate column above it — averaging
 * would weight a barely-used camera the same as the line's main inspection
 * point — and counts a batch once, not once per camera it passed.
 */

export const COLUMNS = {
  camera: { label: 'Camera', align: 'left' },
  inspected: { label: 'Inspected', align: 'num' },
  defects: { label: 'Defects', align: 'num' },
  rate: { label: 'Defect rate', align: 'num' },
  batches: { label: 'Batches', align: 'num' },
  perBatch: { label: 'Defects / batch', align: 'num' },
  worstDefect: { label: 'Worst defect', align: 'left' },
  lastSeen: { label: 'Last seen', align: 'left' },
  status: { label: 'Status', align: 'left' },
}

export const DEFAULT_COLUMNS = ['camera', 'inspected', 'defects', 'rate', 'batches',
  'perBatch', 'worstDefect', 'lastSeen', 'status']

function cell(key, c, multi, tr) {
  switch (key) {
    case 'camera': return cameraLabel(c, multi)
    case 'inspected': return fmtNumber(c.inspected)
    case 'defects': return fmtNumber(c.defects ?? 0)
    case 'rate': return fmtPercent(c.defect_rate_pct)
    case 'batches': return fmtNumber(c.batches ?? 0)
    case 'perBatch': return fmtNumber(c.defects_per_batch, 1)
    case 'worstDefect': return c.worst_defect ?? '—'
    case 'lastSeen': return fmtDateTime(c.last_seen)
    case 'status': return tr(STATUS_LABELS[c.status] ?? c.status ?? '—')
    default: return '—'
  }
}

function sortValue(key, c, multi) {
  switch (key) {
    // Sorting on the rendered label keeps cameras from the same plant adjacent
    // once the source is part of it.
    case 'camera': return cameraLabel(c, multi)
    case 'inspected': return c.inspected ?? -1
    case 'defects': return c.defects ?? 0
    // `null` rate means "not measured". Sorting it as -1 parks those cameras at
    // one end instead of scattering them through the ranking.
    case 'rate': return c.defect_rate_pct ?? -1
    case 'batches': return c.batches ?? 0
    case 'perBatch': return c.defects_per_batch ?? -1
    case 'worstDefect': return c.worst_defect ?? ''
    case 'lastSeen': return c.last_seen ? new Date(c.last_seen).getTime() : -1
    case 'status': return c.status ?? ''
    default: return 0
  }
}

export default function SummaryTable({ block, result }) {
  const tr = useTranslation()
  const [sortKey, setSortKey] = useState('defects')
  const [asc, setAsc] = useState(false)

  // A saved column list is honoured as-is. Lists saved before the batch
  // columns existed gain them once, server-side (db._upgrade_report_templates).
  const columns = (block?.options?.columns ?? DEFAULT_COLUMNS).filter((c) => COLUMNS[c])
  const cameras = useMemo(() => result?.cameras ?? [], [result])
  const multi = isMultiSource(cameras)

  const totals = result?.totals ?? null

  const sorted = useMemo(() => {
    const rows = [...cameras]
    rows.sort((a, b) => {
      const va = sortValue(sortKey, a, multi)
      const vb = sortValue(sortKey, b, multi)
      if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va)
      return asc ? va - vb : vb - va
    })
    return rows
  }, [cameras, sortKey, asc, multi])

  function toggleSort(key) {
    if (key === sortKey) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(key === 'camera')
    }
  }

  const title = tr(block?.title ?? 'Camera Summary')

  if (!cameras.length) {
    return (
      <ReportBlock title={title}>
        <p className={styles['block__empty']}>{tr('No cameras in this window.')}</p>
      </ReportBlock>
    )
  }

  return (
    <ReportBlock title={title} note={tr('Click a header to sort')}>
      <div className={styles['table__scroll']}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((key) => (
                <th
                  key={key}
                  className={COLUMNS[key].align === 'num' ? styles['table__num'] : undefined}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleSort(key)}
                  aria-sort={sortKey === key ? (asc ? 'ascending' : 'descending') : undefined}
                >
                  {tr(COLUMNS[key].label)}
                  {sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={cameraKey(c)}>
                {columns.map((key) => (
                  <td
                    key={key}
                    className={COLUMNS[key].align === 'num' ? styles['table__num'] : undefined}
                    style={
                      key === 'rate'
                        ? { color: defectRateColor(c.defect_rate_pct) }
                        : key === 'status'
                          ? { color: STATUS_COLORS[c.status] }
                          : undefined
                    }
                  >
                    {cell(key, c, multi, tr)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot className={styles['table__foot']}>
              <tr>
                {columns.map((key) => (
                  <td
                    key={key}
                    className={COLUMNS[key].align === 'num' ? styles['table__num'] : undefined}
                  >
                    {key === 'camera'
                      ? tr('All ({count})', { count: totals.camera_count })
                      : key === 'worstDefect'
                        ? (totals.top_defect ?? '—')
                        : ['lastSeen', 'status'].includes(key) ? '' : cell(key, totals, false, tr)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </ReportBlock>
  )
}
