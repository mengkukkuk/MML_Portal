import { useTranslation, useLanguageStore } from '@/i18n'
import { SEVERITY_LABELS, viaNote, eventWhen } from '../kpiView'
import styles from './Blocks.module.css'

const UNAVAILABLE = {
  not_configured: 'No alert source yet — set one in Settings → Alert messages.',
  missing: 'The alert table or one of its columns is not there yet.',
  unreachable: 'Could not reach the alert source.',
}

/**
 * ResponseBoard — the plant's alerts this period and who has to act on them.
 *
 * Alerts come from the one alert source in Settings (Alert messages), routed
 * by the Response roles: the row's own role tag, else the rule for its
 * location, else a global catch-all. Repeats of one check are one event
 * (kpi.py alert_board / alert_events.py), so forty "Check speed" rows read as
 * one thing to do. The owner strip on top is each role's workload; a location
 * no rule names is called out, because its alerts are landing on a catch-all.
 */
export default function ResponseBoard({ summary }) {
  const tr = useTranslation()
  const lang = useLanguageStore((s) => s.language)
  const board = summary?.alerts
  if (!board) return <p className={styles.empty}>{tr('Loading…')}</p>
  if (!board.available) {
    return (
      <p className={styles.empty}>
        {tr(UNAVAILABLE[board.reason] || 'Could not read alerts.')}
        {board.detail ? ` (${board.detail})` : ''}
      </p>
    )
  }
  const roleName = (r) => (r ? (lang === 'th' ? r.name_th : r.name_en) || r.code : tr('Unassigned'))
  const withDate = summary.period?.name !== 'today'
  const where = summary.settings?.response_location
  const hidden = Object.entries(board.alerts || {})
    .filter(([sev]) => (sev === 'info' && board.min_severity !== 'info') || (sev === 'warn' && board.min_severity === 'crit'))
    .reduce((n, [, c]) => n + c, 0)
  const total = Object.values(board.alerts || {}).reduce((n, c) => n + c, 0)

  return (
    <div className={styles.rb}>
      {board.unmatched?.length > 0 && (
        <p className={styles.notice}>
          {tr('No response rule for {l} — its alerts go to {r}.', {
            l: board.unmatched.join(', '),
            r: board.catch_all ? roleName(board.catch_all) : tr('nobody'),
          })}
        </p>
      )}

      {board.by_role?.length > 0 && (
        <ul className={styles.rb__owners} aria-label={tr('Who must act')}>
          {board.by_role.map((o) => (
            <li key={o.role?.code ?? '—'} className={`${styles.rb__owner} ${o.role ? '' : styles['tone--bad']}`}>
              <span className={styles.rb__ownername}>{roleName(o.role)}</span>
              <span className={styles.rb__counts}>
                {o.crit > 0 && <span className={`${styles.rb__pill} ${styles['rb__pill--crit']}`}>{o.crit}</span>}
                {o.warn > 0 && <span className={`${styles.rb__pill} ${styles['rb__pill--warn']}`}>{o.warn}</span>}
                {o.info > 0 && <span className={`${styles.rb__pill} ${styles['rb__pill--info']}`}>{o.info}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!board.events?.length ? (
        <p className={styles.empty}>
          {where && board.locations?.length
            ? tr('No alerts at {w}. This period’s alerts are at {l}.', { w: where, l: board.locations.join(', ') })
            : tr('No alerts to act on this period.')}
        </p>
      ) : (
        <div className={styles.tbl}>
          <table>
            <thead>
              <tr>
                <th>{tr('Time')}</th>
                <th>{tr('Level')}</th>
                <th>{tr('Location')}</th>
                <th>{tr('Alert')}</th>
                <th>{tr('Who must act')}</th>
              </tr>
            </thead>
            <tbody>
              {board.events.map((ev) => {
                const [via, params, tone] = viaNote(ev)
                return (
                  <tr key={`${ev.start}-${ev.kind}-${ev.location}-${ev.severity}`}>
                    <td className={styles.num}>{eventWhen(ev, withDate)}</td>
                    <td>
                      <span className={`${styles.rb__pill} ${styles[`rb__pill--${ev.severity}`]}`}>
                        {tr(SEVERITY_LABELS[ev.severity] || ev.severity)}
                      </span>
                    </td>
                    <td>{ev.location || '—'}</td>
                    <td className={styles.rb__msg} title={ev.first_message ? `${tr('First')}: ${ev.first_message}` : ev.message}>
                      {ev.message}
                      {ev.count > 1 && <span className={styles.rb__times}> ×{ev.count}</span>}
                    </td>
                    <td>
                      <span className={ev.role ? undefined : styles['tone--bad']}>{roleName(ev.role)}</span>
                      <span className={`${styles.rb__via} ${tone ? styles[`tone--${tone}`] : ''}`}>{tr(via, params)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.foot}>
        {tr('{n} events from {a} alerts', { n: board.event_count, a: board.shown_alerts })}
        {hidden > 0 ? ` · ${tr('{h} of {t} below {s} not listed', {
          h: hidden, t: total, s: tr(SEVERITY_LABELS[board.min_severity]),
        })}` : ''}
        {board.event_count > board.events.length ? ` · ${tr('newest {n} shown', { n: board.events.length })}` : ''}
        {board.truncated ? ` · ${tr('oldest alerts left out')}` : ''}
        {` · ${board.table}${board.connection ? ` @ ${board.connection}` : ''}`}
      </p>
    </div>
  )
}
