import { useTranslation } from '@/i18n'
import {
  STATE_LABELS, STATE_TOKENS, andonWord, fmtPieces, stripSegments,
} from '../kpiView'
import styles from './Blocks.module.css'

/**
 * AndonBoard — one coloured tile per detected machine: Run / Slow / Stop /
 * No data, readable from across a room.
 *
 * No data is grey, never red: a dropped VPN is "we don't know", not "the
 * machine stopped". A stopped tile pulses slowly (off under reduced motion).
 * The tile's detail grows with its size (Blocks.module.css @container rules):
 * name and state word when small, speed and run % from ~420px, the 24 h strip
 * and legend from ~560px. The strip draws an unscheduled stop as empty — an
 * idle night, not a red band.
 */
export default function AndonBoard({ summary }) {
  const tr = useTranslation()
  const families = summary?.families || []
  if (!families.length) return <p className={styles.empty}>{tr('No machines detected in this table.')}</p>
  return (
    <>
      <div className={styles.andon}>
        {families.map((f) => (
          <div key={f.key} className={`${styles.tile} ${styles[`tile--${f.state || 'nodata'}`]}`}>
            <span className={styles.tile__name} title={f.label}>{f.label}</span>
            <span className={styles.tile__word}>{andonWord(f, tr)}</span>
            <span className={`${styles.tile__detail} ${styles.num}`}>
              {f.state === 'run' || f.state === 'slow'
                ? `${fmtPieces(f.speed)}/${tr('min')}`
                : f.target ? `${tr('target')} ${fmtPieces(f.target)}/${tr('min')}` : ''}
              {f.run_pct != null && ` · ${tr('running {pct}%', { pct: f.run_pct })}`}
            </span>
            <span className={styles.tile__strip} aria-hidden="true">
              {stripSegments(f.strip).map((s, i) => (
                <span key={i} className={`${styles.seg} ${styles[`seg--${s.state}`]}`} style={{ width: `${s.pct}%` }} />
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        {['run', 'slow', 'stop', 'nodata'].map((s) => (
          <span key={s}>
            <span className={styles.legend__dot} style={{ background: STATE_TOKENS[s] }} />
            {tr(STATE_LABELS[s])}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>{tr('Strip: last 24 h')}</span>
      </div>
    </>
  )
}
