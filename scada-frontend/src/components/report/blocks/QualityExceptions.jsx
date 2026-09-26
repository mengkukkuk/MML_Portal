import ReportBlock from './ReportBlock'
import { SEVERITY_COLORS, cameraLabel, cameraKey, fmtPercent, isMultiSource } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * QualityExceptions — cameras whose defect rate crossed the template's warn or
 * critical threshold in this window.
 *
 * `warnPct`/`critPct` are per-template block options (not a global setting),
 * because the same 4% defect rate is a warning on a loose line and clean on a
 * strict one — see ReportBuilderPage's block editor.
 */

const ORDER = ['critical', 'warning']

export default function QualityExceptions({ block, result }) {
  const exceptions = result?.quality_exceptions
  const warnPct = block?.options?.warnPct ?? 2
  const critPct = block?.options?.critPct ?? 5

  if (!exceptions) return null

  const severities = Object.entries(exceptions.by_severity ?? {}).sort(
    (a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  )
  const top = exceptions.top ?? []
  const multi = isMultiSource(top)

  return (
    <ReportBlock
      title={block?.title ?? 'Quality Exceptions'}
      note={`${exceptions.total} total · warn ≥ ${warnPct}%, crit ≥ ${critPct}%`}
    >
      {exceptions.total === 0 ? (
        <p className={styles['block__empty']}>No cameras exceeded the defect-rate thresholds.</p>
      ) : (
        <>
          <div className={styles['kpi__grid']}>
            {severities.map(([sev, count]) => (
              <div key={sev} className={styles['kpi__card']}>
                <span className={styles['kpi__label']}>{sev}</span>
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
                  <th>Camera</th>
                  <th>Severity</th>
                  <th className={styles['table__num']}>Defect rate</th>
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
                        {row.severity}
                      </span>
                    </td>
                    <td className={styles['table__num']}>{fmtPercent(row.defect_rate_pct)}</td>
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
