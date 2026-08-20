import ReportBlock from './ReportBlock'
import { SEVERITY_COLORS } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * AlarmSummary — alarm counts by severity plus the most frequent alarm texts.
 *
 * Counted independently of the Pareto on purpose: the Pareto measures lost
 * *time*, this measures *noise*. An alarm that fires constantly but never stops
 * the line is invisible in one and top of the other, and both readings matter.
 */

const ORDER = ['critical', 'warning', 'info']

export default function AlarmSummary({ block, result }) {
  const summary = result?.alarm_summary
  const topN = block?.options?.topN ?? 10

  if (!summary) return null

  const severities = Object.entries(summary.by_severity ?? {}).sort(
    (a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  )
  const top = (summary.top ?? []).slice(0, topN)

  return (
    <ReportBlock
      title={block?.title ?? 'Alarm Summary'}
      note={`${summary.total} total`}
    >
      {summary.total === 0 ? (
        <p className={styles['block__empty']}>No alarms in this window.</p>
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
                  <th>Alarm</th>
                  <th>Severity</th>
                  <th className={styles['table__num']}>Count</th>
                </tr>
              </thead>
              <tbody>
                {top.map((row) => (
                  <tr key={row.alarm}>
                    <td className={styles['table__wrap']}>{row.alarm}</td>
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
                    <td className={styles['table__num']}>{row.count}</td>
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
