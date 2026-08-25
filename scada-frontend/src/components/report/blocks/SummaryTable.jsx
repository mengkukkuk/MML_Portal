import { useMemo, useState } from 'react'
import ReportBlock from './ReportBlock'
import { fmtDuration, fmtPct, gradeColor, isMultiSource, machineKey, machineLabel } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * SummaryTable — one row per machine, plus a totals footer.
 *
 * The footer recomputes from the server's `totals`, which sums seconds rather
 * than averaging the percentage column above it. Averaging would weight a
 * rarely-used machine the same as the line's bottleneck and quietly misreport
 * the line, so the footer availability intentionally does not equal the mean of
 * the column.
 */

const COLUMNS = {
  machine: { label: 'Machine', align: 'left' },
  runtime: { label: 'Runtime', align: 'num' },
  downtime: { label: 'Downtime', align: 'num' },
  unknown: { label: 'Unmeasured', align: 'num' },
  availability: { label: 'Availability', align: 'num' },
  oee: { label: 'OEE (A-only)', align: 'num' },
  stops: { label: 'Stops', align: 'num' },
  mtbf: { label: 'MTBF', align: 'num' },
  mttr: { label: 'MTTR', align: 'num' },
  alarms: { label: 'Alarms', align: 'num' },
}

const DEFAULT_COLUMNS = [
  'machine', 'runtime', 'downtime', 'availability', 'stops', 'mtbf', 'mttr', 'alarms',
]

function cell(key, m, multi) {
  switch (key) {
    case 'machine': return machineLabel(m, multi)
    case 'runtime': return fmtDuration(m.run_s)
    case 'downtime': return fmtDuration(m.downtime_s)
    case 'unknown': return fmtDuration(m.unknown_s)
    case 'availability': return fmtPct(m.availability)
    case 'oee': return fmtPct(m.oee)
    case 'stops': return m.stop_count ?? 0
    case 'mtbf': return fmtDuration(m.mtbf_s)
    case 'mttr': return fmtDuration(m.mttr_s)
    case 'alarms': return m.alarm_count ?? 0
    default: return '—'
  }
}

function sortValue(key, m, multi) {
  switch (key) {
    // Sorting on the rendered label keeps machines from the same plant adjacent
    // once the source is part of it.
    case 'machine': return machineLabel(m, multi)
    case 'runtime': return m.run_s
    case 'downtime': return m.downtime_s
    case 'unknown': return m.unknown_s
    // `null` availability means "not measured". Sorting it as -1 parks those
    // machines at one end instead of scattering them through the ranking.
    case 'availability':
    case 'oee': return m.availability ?? -1
    case 'stops': return m.stop_count ?? 0
    case 'mtbf': return m.mtbf_s ?? -1
    case 'mttr': return m.mttr_s ?? -1
    case 'alarms': return m.alarm_count ?? 0
    default: return 0
  }
}

export default function SummaryTable({ block, result }) {
  const [sortKey, setSortKey] = useState('availability')
  const [asc, setAsc] = useState(true)

  const columns = (block?.options?.columns ?? DEFAULT_COLUMNS).filter((c) => COLUMNS[c])
  const machines = result?.machines ?? []
  const multi = isMultiSource(machines)

  // `totals` carries no alarm count — the server aggregates alarms separately,
  // and that summary counts every alarm in the window whether or not it landed
  // on a machine that made it into this table. Summing the column is the figure
  // that actually reconciles with the rows above.
  const totals = useMemo(() => {
    if (!result?.totals) return null
    return {
      ...result.totals,
      alarm_count: machines.reduce((n, m) => n + (m.alarm_count ?? 0), 0),
    }
  }, [result, machines])

  const sorted = useMemo(() => {
    const rows = [...machines]
    rows.sort((a, b) => {
      const va = sortValue(sortKey, a, multi)
      const vb = sortValue(sortKey, b, multi)
      if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va)
      return asc ? va - vb : vb - va
    })
    return rows
  }, [machines, sortKey, asc, multi])

  function toggleSort(key) {
    if (key === sortKey) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(key === 'machine')
    }
  }

  if (!machines.length) {
    return (
      <ReportBlock title={block?.title ?? 'Machine Summary'}>
        <p className={styles['block__empty']}>No machines in this window.</p>
      </ReportBlock>
    )
  }

  return (
    <ReportBlock title={block?.title ?? 'Machine Summary'} note="Click a header to sort">
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
                >
                  {COLUMNS[key].label}
                  {sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={machineKey(m)}>
                {columns.map((key) => (
                  <td
                    key={key}
                    className={COLUMNS[key].align === 'num' ? styles['table__num'] : undefined}
                    style={
                      key === 'availability' || key === 'oee'
                        ? { color: gradeColor(m.availability) }
                        : undefined
                    }
                  >
                    {cell(key, m, multi)}
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
                    {key === 'machine' ? `All (${totals.machine_count})` : cell(key, totals)}
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
