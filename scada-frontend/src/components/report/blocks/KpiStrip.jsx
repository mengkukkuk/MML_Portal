import ReportBlock from './ReportBlock'
import { fmtPercent, defectRateColor } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * KpiStrip — the headline numbers, computed from the same camera aggregates as
 * every other block so the cards can never disagree with the table below them.
 */

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

  const targetDefectPct = block?.options?.targetDefectPct ?? 2
  const cameras = result?.cameras ?? []
  const reporting = cameras.filter((c) => c.status !== 'no_data').length

  return (
    <ReportBlock
      title={block?.title ?? 'Overview'}
      note={`${t.camera_count} ${t.camera_count === 1 ? 'camera' : 'cameras'}`}
    >
      <div className={styles['kpi__grid']}>
        <Card label="Inspected" value={t.inspected.toLocaleString()} sub="Total units" />
        <Card label="Defects" value={t.defects.toLocaleString()} sub="Total flagged" />
        <Card
          label="Defect rate"
          value={fmtPercent(t.defect_rate_pct)}
          sub={`Target < ${targetDefectPct}%`}
          color={defectRateColor(t.defect_rate_pct)}
        />
        <Card
          label="Cameras reporting"
          value={`${reporting} / ${cameras.length}`}
          sub="Wrote at least one hour"
          color={reporting < cameras.length ? 'var(--warn)' : undefined}
        />
      </div>
    </ReportBlock>
  )
}
