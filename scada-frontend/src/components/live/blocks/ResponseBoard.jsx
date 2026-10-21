import { useTranslation, useLanguageStore } from '@/i18n'
import { fmtPieces } from '../kpiView'
import styles from './Blocks.module.css'

// a clock time for today; the date too once the period spans several days
const when = (iso, withDate) => (iso ? new Date(iso).toLocaleString([], {
  ...(withDate ? { day: 'numeric', month: 'numeric' } : {}), hour: '2-digit', minute: '2-digit',
}) : '—')

/**
 * ResponseBoard — every out-of-band incident this period: how long, how many
 * pieces were made meanwhile (to hold for inspection), and who answered it and
 * how fast — the first parameter change on that sensor afterwards, from the
 * plant's event log. Unanswered incidents stay red; the role column comes from
 * the response-role rules (Settings), so the board knows whose move it is even
 * when nobody has moved yet.
 */
export default function ResponseBoard({ summary }) {
  const tr = useTranslation()
  const lang = useLanguageStore((s) => s.language)
  const rows = summary?.incidents || []
  if (!rows.length) return <p className={styles.empty}>{tr('No out-of-band incidents this period.')}</p>
  const withDate = summary.period?.name !== 'today'
  const roleName = (r) => (r ? (lang === 'th' ? r.name_th : r.name_en) || r.code : '—')
  return (
    <div className={styles.tbl}>
      <table>
        <thead>
          <tr>
            <th>{tr('Incident')}</th>
            <th className={styles.r}>{tr('Minutes')}</th>
            <th className={styles.r}>{tr('At risk')}</th>
            <th className={styles.r}>{tr('Response')}</th>
            <th>{tr('By')}</th>
            <th>{tr('Owner')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = r.response_min == null
            return (
              <tr key={`${r.tag}-${r.start}`} className={open ? styles['tone--bad'] : undefined}>
                <td>{r.tag} {when(r.start, withDate)}{r.open ? ` · ${tr('ongoing')}` : ''}</td>
                <td className={`${styles.r} ${styles.num}`}>{r.minutes}</td>
                <td className={`${styles.r} ${styles.num}`}>{fmtPieces(r.risk_pieces)}</td>
                <td className={`${styles.r} ${styles.num}`}>{open ? '—' : `${r.response_min} ${tr('min')}`}</td>
                <td title={r.action || ''}>{open ? tr('Nobody yet') : (r.by || tr('unknown'))}</td>
                <td>{roleName(r.role)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
