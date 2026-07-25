import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import CircularProgress from '@mui/material/CircularProgress'
import RefreshIcon from '@mui/icons-material/Refresh'
import { fetchRecentAlarms, fetchActiveAlarms, acknowledgeAlarm } from '@/api/alarms'
import styles from './AlarmsPage.module.css'

/**
 * AlarmsPage — alarm log viewer (route: /alarms).
 * Reads public.alarm_logs via /api/alarms/recent and renders a
 * location -> tag_name -> alarms tree mirroring the Events page, plus
 * per-card severity tinting and an inline Acknowledge button.
 *
 * Two independent TanStack Query pollers (ported from the Vue version's two
 * setInterval timers):
 *  - "recent" — the historical log stack, every 30s (POLL_MS), keyed on
 *    perCard so switching 5/10/25 refetches with the new limit.
 *  - "active" — tags currently in alarm, every 1s (ACTIVE_POLL_MS),
 *    independent of perCard so the active-alarm card appears within ~1s of
 *    the backend setting variables_tag.alarm_no.
 * Both set refetchIntervalInBackground so a backgrounded SCADA wall-display
 * tab keeps polling (Query's default pauses refetchInterval when hidden).
 *
 * Acknowledge is a useMutation; per-row pending state is derived by
 * comparing the mutation's `variables` (the alarm id) against each row,
 * rather than a separate loading array/Set.
 */

const POLL_MS = 30_000
const ACTIVE_POLL_MS = 1_000
const UNKNOWN = 'Unknown'
const SEV_RANK = { critical: 3, warning: 2, info: 1 }

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

function sevLabel(s) {
  return (s || 'info').toUpperCase()
}

export default function AlarmsPage() {
  const queryClient = useQueryClient()
  const [perCard, setPerCard] = useState(10)
  const [expanded, setExpanded] = useState(null) // key of currently open card, null = all collapsed

  const recentQuery = useQuery({
    queryKey: ['alarms', 'recent', perCard],
    queryFn: () => fetchRecentAlarms(perCard),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  })

  const activeQuery = useQuery({
    queryKey: ['alarms', 'active'],
    queryFn: fetchActiveAlarms,
    refetchInterval: ACTIVE_POLL_MS,
    refetchIntervalInBackground: true,
  })

  const ackMutation = useMutation({
    mutationFn: acknowledgeAlarm,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alarms', 'recent'] }),
  })

  const alarms = recentQuery.data ?? []
  const activeAlarms = activeQuery.data ?? []
  const loading = recentQuery.isLoading
  const error = recentQuery.error
    ? recentQuery.error?.response?.data?.detail || recentQuery.error?.message || String(recentQuery.error)
    : ''

  const hasActive = activeAlarms.length > 0

  const grouped = useMemo(() => {
    const locations = []
    let curLoc = null
    let curTag = null
    for (const row of alarms) {
      const location = row.location ?? UNKNOWN
      const tagName = row.tag_name ?? UNKNOWN
      if (!curLoc || curLoc.location !== location) {
        curLoc = { location, tags: [], alarmCount: 0 }
        locations.push(curLoc)
        curTag = null
      }
      if (!curTag || curTag.tag_name !== tagName) {
        curTag = { tag_name: tagName, alarms: [], severity: 'info', unacked: 0 }
        curLoc.tags.push(curTag)
      }
      curTag.alarms.push(row)
      const sev = row.severity || 'info'
      if ((SEV_RANK[sev] || 0) > (SEV_RANK[curTag.severity] || 0)) {
        curTag.severity = sev
      }
      if (!row.acknowledged) curTag.unacked += 1
      curLoc.alarmCount += 1
    }
    return locations
  }, [alarms])

  const isEmpty = !loading && !error && grouped.length === 0
  const updatedLabel = recentQuery.dataUpdatedAt
    ? new Date(recentQuery.dataUpdatedAt).toLocaleTimeString()
    : '—'

  function toggleCard(key) {
    setExpanded((cur) => (cur === key ? null : key))
  }

  function handleRefresh() {
    recentQuery.refetch()
    activeQuery.refetch()
  }

  return (
    <div className={styles.page}>
      <header className={styles['page__head']}>
        <h2 className={styles['page__title']}>Alarms</h2>
        <div className={styles['page__controls']}>
          <span className={styles['alm__updated']}>
            <span
              className={`${styles['alm__dot']} ${!error ? styles['alm__dot--live'] : ''}`}
              aria-hidden="true"
            />
            Updated {updatedLabel}
          </span>
          <FormControl size="small" className={styles['alm__select']}>
            <Select value={perCard} onChange={(e) => setPerCard(Number(e.target.value))}>
              <MenuItem value={5}>Last 5</MenuItem>
              <MenuItem value={10}>Last 10</MenuItem>
              <MenuItem value={25}>Last 25</MenuItem>
            </Select>
          </FormControl>
          <Button
            startIcon={<RefreshIcon />}
            loading={recentQuery.isFetching}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
      </header>

      {hasActive && (
        <section className={styles['alm__active']}>
          <header className={styles['alm__active-head']}>
            <span className={styles['alm__active-dot']} aria-hidden="true" />
            <span className={styles['alm__active-title']}>Active Alarms</span>
            <span className={styles['alm__active-count']}>{activeAlarms.length} active</span>
          </header>
          <div className={styles['alm__active-grid']}>
            {activeAlarms.map((al) => (
              <article
                key={`${al.location}::${al.tag_name}::${al.alarm_no}`}
                className={`${styles['alm__active-card']} ${styles[`alm__active-card--${al.severity || 'info'}`]}`}
              >
                <div className={styles['alm__active-card-top']}>
                  <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${al.severity || 'info'}`]}`}>
                    {sevLabel(al.severity)}
                  </span>
                  <span className={styles['alm__active-value']}>{al.alarm_value ?? '—'}</span>
                </div>
                <span className={styles['alm__active-tag']}>{al.tag_name ?? '—'}</span>
                <span className={styles['alm__active-loc']}>{al.location ?? '—'}</span>
                <p className={styles['alm__active-msg']}>{al.alarm ?? '—'}</p>
                <time className={styles['alm__active-time']}>{fmtTime(al.at_date_time)}</time>
              </article>
            ))}
          </div>
        </section>
      )}

      {error && <p className={styles['page__error']}>{error}</p>}
      {!error && loading && !alarms.length && (
        <p className={styles['page__empty']}>Loading alarms…</p>
      )}
      {!error && isEmpty && <p className={styles['page__empty']}>No alarms recorded.</p>}

      {grouped.map((loc) => (
        <section key={loc.location} className={styles['alm__loc']}>
          <header className={styles['alm__loc-head']}>
            <span className={styles['alm__loc-name']}>{loc.location}</span>
            <span className={styles['alm__loc-meta']}>
              {loc.tags.length} {loc.tags.length === 1 ? 'tag' : 'tags'} · {loc.alarmCount}{' '}
              {loc.alarmCount === 1 ? 'alarm' : 'alarms'}
            </span>
          </header>

          <div className={styles['alm__stack']}>
            {loc.tags.map((tag) => {
              const key = `${loc.location}::${tag.tag_name}`
              const isOpen = expanded === key
              return (
                <article
                  key={tag.tag_name}
                  className={`${styles['alm__tag']} ${styles[`alm__tag--${tag.severity}`]} ${
                    !isOpen ? styles['alm__tag--collapsed'] : ''
                  }`}
                >
                  <header className={styles['alm__tag-head']} onClick={() => toggleCard(key)}>
                    <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${tag.severity}`]}`}>
                      {sevLabel(tag.severity)}
                    </span>
                    <span className={styles['alm__tag-name']}>{tag.tag_name}</span>
                    <div className={styles['alm__tag-actions']}>
                      {tag.unacked > 0 && (
                        <span
                          className={`${styles['alm__badge']} ${styles['alm__badge--unacked']}`}
                          title={`${tag.unacked} unacknowledged`}
                        >
                          {tag.unacked}
                        </span>
                      )}
                      <span className={styles['alm__badge']}>{tag.alarms.length}</span>
                      <button
                        type="button"
                        className={styles['alm__minimize']}
                        aria-label={isOpen ? 'Minimize' : 'Expand'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleCard(key)
                        }}
                      >
                        {isOpen ? '−' : '+'}
                      </button>
                    </div>
                  </header>
                  {isOpen && (
                    <ol className={styles['alm__timeline']}>
                      {tag.alarms.map((al, i) => {
                        const isPending = ackMutation.variables === al.id && ackMutation.isPending
                        return (
                          <li
                            key={al.id}
                            className={`${styles['alm__item']} ${styles[`alm__item--${al.severity || 'info'}`]} ${
                              i === 0 ? styles['alm__item--latest'] : ''
                            }`}
                          >
                            <span className={styles['alm__node']} aria-hidden="true" />
                            <div className={styles['alm__body']}>
                              <div className={styles['alm__row']}>
                                <span className={styles['alm__text']}>{al.alarm ?? '—'}</span>
                                {al.acknowledged ? (
                                  <span
                                    className={styles['alm__ack-pill']}
                                    title={
                                      al.acknowledged_at
                                        ? `Acknowledged ${fmtTime(al.acknowledged_at)}`
                                        : 'Acknowledged'
                                    }
                                  >
                                    Ack
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className={styles['alm__ack-btn']}
                                    disabled={isPending}
                                    onClick={() => ackMutation.mutate(al.id)}
                                  >
                                    {isPending ? (
                                      <CircularProgress size={10} color="inherit" />
                                    ) : (
                                      'Acknowledge'
                                    )}
                                  </button>
                                )}
                              </div>
                              <time className={styles['alm__time']}>{fmtTime(al.at_date_time)}</time>
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
