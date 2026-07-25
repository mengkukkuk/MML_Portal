import styles from './StatCard.module.css'

/**
 * StatCard — KPI summary card used in the OverviewPage grid.
 * Props:
 *   label — metric name displayed in small caps
 *   value — numeric or string reading
 *   unit  — optional suffix (e.g. '°C', '%')
 *   trend — optional delta string (e.g. '+2.1%')
 *   tone  — left-border colour: 'default' | 'ok' | 'warn' | 'crit'
 *   icon  — optional icon element shown in the card header (e.g.
 *           `<CircleCheckOutlined fontSize="small" />`) — ported from the
 *           Vue version's Element Plus icon-name string prop; callers now
 *           pass a per-path-imported MUI icon element instead.
 */
export default function StatCard({ label, value, unit = '', trend = '', tone = 'default', icon = null }) {
  return (
    <div className={styles.card} data-tone={tone}>
      <div className={styles.head}>
        <span>{label}</span>
        {icon && <span className={styles.icon}>{icon}</span>}
      </div>
      <div className={styles.valueRow}>
        <span className={styles.value}>{value}</span>
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
      {trend && <div className={styles.trend}>{trend}</div>}
    </div>
  )
}
