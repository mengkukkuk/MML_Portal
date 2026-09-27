import ReportBlock from './ReportBlock'
import { useTranslation } from '@/i18n'
import { fmtNumber, fmtPercent, defectRateColor } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * KpiStrip — the headline numbers, computed from the same camera aggregates as
 * every other block so the cards can never disagree with the table below them.
 *
 * Defects, batches and the top defect type come from camera_defect_logs. The
 * rate needs an inspected count, which only production_hourly_log carries; a
 * plant without that table shows the rate as unavailable and says why, rather
 * than a 0% that would read as a perfect line.
 */

function Card({ label, value, sub, color, wide }) {
  return (
    <div className={`${styles['kpi__card']} ${wide ? styles['kpi__card--wide'] : ''}`}>
      <span className={styles['kpi__label']}>{label}</span>
      <span className={styles['kpi__value']} style={color ? { color } : undefined} title={String(value)}>
        {value}
      </span>
      {sub && <span className={styles['kpi__sub']}>{sub}</span>}
    </div>
  )
}

export default function KpiStrip({ block, result }) {
  const tr = useTranslation()
  const t = result?.totals
  if (!t) return null

  const targetDefectPct = block?.options?.targetDefectPct ?? 2
  const noInspected = t.inspected == null

  return (
    <ReportBlock
      title={tr(block?.title ?? 'Overview')}
      note={tr('{count} cameras', { count: t.camera_count })}
    >
      <div className={styles['kpi__grid']}>
        <Card label={tr('Defects')} value={fmtNumber(t.defects)} sub={tr('Total flagged')} />
        <Card label={tr('Batches')} value={fmtNumber(t.batches)} sub={tr('Distinct batches logged')} />
        <Card
          label={tr('Defects / batch')}
          value={fmtNumber(t.defects_per_batch, 1)}
          sub={tr('Average per batch')}
        />
        <Card
          label={tr('Top defect')}
          value={t.top_defect ?? '—'}
          sub={tr('Most frequent type')}
          wide
        />
        <Card
          label={tr('Defect rate')}
          value={fmtPercent(t.defect_rate_pct)}
          sub={noInspected
            ? tr('No inspected count')
            : tr('{count} inspected · target < {target}%', {
              count: fmtNumber(t.inspected), target: targetDefectPct })}
          color={defectRateColor(t.defect_rate_pct, targetDefectPct, targetDefectPct * 2)}
        />
        <Card
          label={tr('Cameras reporting')}
          value={`${t.cameras_reporting} / ${t.camera_count}`}
          sub={tr('Logged at least one batch')}
          color={t.cameras_reporting < t.camera_count ? 'var(--warn)' : undefined}
        />
      </div>
      {noInspected && (
        <p className={styles['kpi__caveat']}>
          {tr('Defect rate needs an inspected count from production_hourly_log, which the selected source does not provide. Every count on this page is still exact.')}
        </p>
      )}
    </ReportBlock>
  )
}
