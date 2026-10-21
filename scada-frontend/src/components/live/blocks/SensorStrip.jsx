import { useTranslation } from '@/i18n'
import { SENSOR_LABELS, SENSOR_TOKENS, stripSegments } from '../kpiView'
import styles from './Blocks.module.css'

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }))

/**
 * SensorStrip — one band per sensor across the period: normal, out of its own
 * low–high, frozen (the same value for `flat_min` minutes or more), or no data.
 *
 * A frozen sensor is shown as loudly as an out-of-band one: a temperature that
 * reads 0 against a setpoint of 500 all day is "in band" by its limits and
 * still blind. The last reading and its limits sit beside the name, so "why is
 * this red" is answered without opening another page.
 */
export default function SensorStrip({ summary }) {
  const tr = useTranslation()
  const sensors = summary?.sensors || []
  if (!sensors.length) return <p className={styles.empty}>{tr('No sensor columns in this table.')}</p>
  const end = Date.parse(summary.period?.end)
  return (
    <>
      <div className={styles.sensors}>
        {sensors.map((s) => (
          <div key={s.key} className={styles.sensor}>
            <span className={styles.sensor__name} title={s.key}>
              {s.key}
              <span className={`${styles.sensor__val} ${styles.num} ${s.state === 'out' ? styles['tone--bad'] : s.state === 'flat' ? styles['tone--warn'] : ''}`}>
                {fmt(s.last?.last)}
                {s.last?.low != null && ` (${fmt(s.last.low)}–${fmt(s.last.high)})`}
              </span>
            </span>
            <span className={styles.sensor__bar} aria-label={`${s.key}: ${tr(SENSOR_LABELS[s.state] || 'No data')}`}>
              {stripSegments(s.strip, end).map((seg, i) => (
                <span key={i}
                  className={seg.state === 'missing' ? styles['sensor__seg--missing'] : undefined}
                  style={{ width: `${seg.pct}%`, background: SENSOR_TOKENS[seg.state] }} />
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.legend} style={{ display: 'flex' }}>
        {['ok', 'out', 'flat', 'missing'].map((k) => (
          <span key={k}>
            <span className={`${styles.legend__dot} ${k === 'missing' ? styles['sensor__seg--missing'] : ''}`}
              style={{ background: SENSOR_TOKENS[k] }} />
            {tr(SENSOR_LABELS[k])}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>{tr('frozen = unchanged {m} min', { m: summary.settings?.flat_min ?? 10 })}</span>
      </div>
    </>
  )
}
