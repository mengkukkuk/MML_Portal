import ReportBlock from './ReportBlock'
import { fmtDuration, fmtPct, gradeColor, OEE_CAVEAT } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * KpiStrip — the headline numbers, computed from the same intervals as every
 * other block so the cards can never disagree with the table below them.
 *
 * The OEE card is deliberately labelled `OEE (A-only)`: this deployment has no
 * production counts, so Performance and Quality are assumed 100%. Putting the
 * caveat in the label rather than a tooltip is what makes it survive a
 * screenshot pasted into a management deck.
 */

const LOW_COVERAGE = 0.9

function Card({ label, value, sub, color }) {
  return (
    <div className={styles['kpi__card']}>
      <span className={styles['kpi__label']}>{label}</span>
      <span className={styles['kpi__value']} style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className={styles['kpi__sub']}>{sub}</span>}
    </div>
  )
}

export default function KpiStrip({ block, result }) {
  const t = result?.totals
  if (!t) return null

  const targets = block?.options?.targets ?? {}
  const availTarget = (targets.availability ?? 90) / 100
  const oeeTarget = (targets.oee ?? 85) / 100

  const coverage = t.window_s > 0 ? t.measured_s / (t.window_s * (t.machine_count || 1)) : null
  const lowCoverage = coverage != null && coverage < LOW_COVERAGE

  return (
    <ReportBlock
      title={block?.title ?? 'Overview'}
      note={`${t.machine_count} ${t.machine_count === 1 ? 'machine' : 'machines'}`}
    >
      {lowCoverage && (
        <p className={styles.warning}>
          Only {fmtPct(coverage)} of the selected window has usable state data. The
          unobserved time is excluded from availability rather than guessed at.
        </p>
      )}

      <div className={styles['kpi__grid']}>
        <Card
          label="OEE (A-only)"
          value={fmtPct(t.oee)}
          sub={`Target ${fmtPct(oeeTarget, 0)}`}
          color={gradeColor(t.oee, oeeTarget)}
        />
        <Card
          label="Availability"
          value={fmtPct(t.availability)}
          sub={`Target ${fmtPct(availTarget, 0)}`}
          color={gradeColor(t.availability, availTarget)}
        />
        <Card label="Runtime" value={fmtDuration(t.run_s)} sub="Producing" />
        <Card
          label="Downtime"
          value={fmtDuration(t.downtime_s)}
          sub="Stop + idle + planned"
          color="var(--crit)"
        />
        <Card label="Stops" value={t.stop_count ?? 0} sub="Transitions into a down state" />
        <Card label="MTBF" value={fmtDuration(t.mtbf_s)} sub="Mean time between failures" />
        <Card label="MTTR" value={fmtDuration(t.mttr_s)} sub="Mean time to recover" />
        <Card
          label="Unmeasured"
          value={fmtDuration(t.unknown_s)}
          sub="Excluded from availability"
          color={t.unknown_s > 0 ? 'var(--warn)' : undefined}
        />
      </div>

      <p className={styles['kpi__caveat']}>{OEE_CAVEAT}</p>
    </ReportBlock>
  )
}
