import ReportBlock from './ReportBlock'
import { useTranslation } from '@/i18n'
import { SEVERITY_COLORS, cameraLabel, cameraKey, fmtNumber, fmtPercent, isMultiSource } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * QualityExceptions — cameras whose defect rate crossed the template's warn or
 * critical threshold in this window.
 *
 * `warnPct`/`critPct` are per-template block options (not a global setting),
 * because the same 4% defect rate is a warning on a loose line and clean on a
 * strict one — see ReportBuilderPage's block editor.
 *
 * A rate needs an inspected count. When no camera has one (the source has no
 * production_hourly_log), an empty list would read as "all clear", so the
 * block says the check could not run instead.
 */

const ORDER = ['critical', 'warning']
const SEVERITY_LABELS = { critical: 'Critical', warning: 'Warning' }

export default function QualityExceptions({ block, result }) {
  const tr = useTranslation()
  const exceptions = result?.quality_exceptions
  const warnPct = block?.options?.warnPct ?? 2
  const critPct = block?.options?.critPct ?? 5

  if (!exceptions) return null

  const severities = Object.entries(exceptions.by_severity ?? {}).sort(
    (a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  )
  const top = exceptions.top ?? []
  const multi = isMultiSource(top)
  const unrated = exceptions.rated_cameras === 0

  return (
    <ReportBlock
      title={tr(block?.title ?? 'Quality Exceptions')}
      note={tr('{count} total · warn ≥ {warn}%, crit ≥ {crit}%', {
        count: exceptions.total, warn: warnPct, crit: critPct,
      })}
    >
      {unrated ? (
        <p className={styles['block__empty']}>
          {tr('No camera has a defect rate in this window — rates need an inspected count from production_hourly_log.')}
        </p>
      ) : exceptions.total === 0 ? (
        <p className={styles['block__empty']}>{tr('No cameras exceeded the defect-rate thresholds.')}</p>
      ) : (
        <>
          <div className={styles['kpi__grid']}>
            {severities.map(([sev, count]) => (
              <div key={sev} className={styles['kpi__card']}>
                <span className={styles['kpi__label']}>{tr(SEVERITY_LABELS[sev] ?? sev)}</span>
                <span
                  className={styles['kpi__value']}
                  style={{ color: SEVERITY_COLORS[sev] ?? 'var(--fg)' }}
                >
                  {count}
                </span>
              </div>
            ))}
          </div>

          <div className={styles['table__scroll']}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{tr('Camera')}</th>
                  <th>{tr('Severity')}</th>
                  <th className={styles['table__num']}>{tr('Defect rate')}</th>
                  <th className={styles['table__num']}>{tr('Defects')}</th>
                  <th>{tr('Top defect')}</th>
                </tr>
              </thead>
              <tbody>
                {top.map((row) => (
                  <tr key={cameraKey(row)}>
                    <td className={styles['table__wrap']}>{cameraLabel(row, multi)}</td>
                    <td>
                      <span
                        className={styles.pill}
                        style={{
                          color: SEVERITY_COLORS[row.severity] ?? 'var(--fg-muted)',
                          background: `color-mix(in srgb, ${
                            SEVERITY_COLORS[row.severity] ?? '#5b6a86'
                          } 18%, transparent)`,
                        }}
                      >
                        {tr(SEVERITY_LABELS[row.severity] ?? row.severity)}
                      </span>
                    </td>
                    <td className={styles['table__num']}>{fmtPercent(row.defect_rate_pct)}</td>
                    <td className={styles['table__num']}>{fmtNumber(row.defects)}</td>
                    <td>{row.worst_defect ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ReportBlock>
  )
}
