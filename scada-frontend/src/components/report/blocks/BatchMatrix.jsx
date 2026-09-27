import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import { defectPalette, fmtDateTime, fmtNumber, heatBackground } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * BatchMatrix — camera_batch_work as the engineer reads it: one row per batch,
 * one column per camera, each cell that camera's defect total for the batch.
 *
 * Where the summary answers "which camera", this answers "which batch, and did
 * every camera see it or only one" — a defect that lights up one column is a
 * camera or station problem; one that lights up a whole row is the material.
 *
 * Expanding a row names each camera's defects with that camera's own
 * `defect_labels` (the server pairs them in the plant's database, so two
 * cameras with different label lists are each named correctly).
 */

export default function BatchMatrix({ block, result }) {
  const tr = useTranslation()
  const matrix = result?.batch_matrix
  const [open, setOpen] = useState(() => new Set())

  const cameras = useMemo(() => matrix?.cameras ?? [], [matrix])
  const batches = useMemo(() => matrix?.batches ?? [], [matrix])
  const multi = useMemo(
    () => new Set(batches.map((b) => b.datasource_id ?? null)).size > 1,
    [batches],
  )
  const max = useMemo(
    () => batches.reduce((m, b) => Math.max(m, ...Object.values(b.cells).map((c) => c.total)), 0),
    [batches],
  )
  const palette = useMemo(
    () => defectPalette(batches.flatMap((b) => Object.values(b.cells).flatMap((c) => c.slots.map((s) => s.defect)))),
    [batches],
  )

  const title = tr(block?.title ?? 'Batch x Camera Matrix')
  if (!matrix) return null
  if (!batches.length) {
    return (
      <ReportBlock title={title}>
        <p className={styles['block__empty']}>{tr('No batches in this window.')}</p>
      </ReportBlock>
    )
  }

  const batchKey = (b) => `${b.datasource_id ?? ''}:${b.batch_id}`
  const toggle = (key) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <ReportBlock
      title={title}
      note={tr('{count} batches · click a row for defect detail', { count: batches.length })}
    >
      {matrix.truncated && (
        <p className={styles.warning}>{tr('Showing the newest batches only. Narrow the window to see older ones.')}</p>
      )}
      <div className={styles['table__scroll']}>
        <table className={`${styles.table} ${styles.matrix}`}>
          <thead>
            <tr>
              <th>{tr('Batch')}</th>
              {multi && <th>{tr('Source')}</th>}
              <th>{tr('Started')}</th>
              <th>{tr('Last update')}</th>
              {cameras.map((c) => (
                <th key={c.key} className={styles['table__num']} title={c.code ?? c.key}>
                  {c.name ?? c.key}
                </th>
              ))}
              <th className={styles['table__num']}>{tr('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const key = batchKey(b)
              const expanded = open.has(key)
              return (
                <Fragment key={key}>
                  <tr
                    className={styles['matrix__row']}
                    onClick={() => toggle(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key) }
                    }}
                    tabIndex={0}
                    aria-expanded={expanded}
                  >
                    <td className={styles['matrix__batch']}>
                      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {b.batch_id}
                      {b.status && <span className={styles['matrix__status']}>{b.status}</span>}
                    </td>
                    {multi && <td>{b.datasource_name ?? '—'}</td>}
                    <td>{fmtDateTime(b.created_at)}</td>
                    <td>{fmtDateTime(b.updated_at)}</td>
                    {cameras.map((c) => {
                      const cellData = b.cells[c.key]
                      return (
                        <td
                          key={c.key}
                          className={styles['table__num']}
                          style={{ background: heatBackground(cellData?.total, max) }}
                        >
                          {cellData ? fmtNumber(cellData.total) : '—'}
                        </td>
                      )
                    })}
                    <td className={`${styles['table__num']} ${styles['matrix__total']}`}>
                      {fmtNumber(b.total)}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className={styles['matrix__detail']}>
                      <td colSpan={cameras.length + (multi ? 5 : 4)}>
                        <div className={styles['matrix__cams']}>
                          {cameras.map((c) => {
                            const slots = b.cells[c.key]?.slots ?? []
                            return (
                              <div key={c.key} className={styles['matrix__cam']}>
                                <span className={styles['matrix__camname']}>{c.name ?? c.key}</span>
                                {slots.length ? (
                                  <div className={styles.chips}>
                                    {slots.map((s) => (
                                      <span key={s.slot} className={styles.chip} title={tr('Slot {slot}', { slot: s.slot })}>
                                        <i className={styles['chip__dot']} style={{ background: palette.get(s.defect) }} />
                                        {s.defect}
                                        <b>{fmtNumber(s.count)}</b>
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className={styles['matrix__none']}>
                                    {b.cells[c.key] ? tr('No defects') : tr('Not in this batch')}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </ReportBlock>
  )
}
