import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import CircularProgress from '@mui/material/CircularProgress'
import RefreshIcon from '@mui/icons-material/Refresh'
import { fetchRecentAlarms, fetchActiveAlarms, acknowledgeAlarm } from '@/api/alarms'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import SourceStatus from '@/components/SourceStatus/SourceStatus.jsx'
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

  // In the key rather than only invalidated on change: rows are merged from the
  // selected plants, so a new selection is a different result set.
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const recentQuery = useQuery({
    queryKey: ['alarms', 'recent', perCard, selectionKey],
    queryFn: () => fetchRecentAlarms(perCard),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  })

  const activeQuery = useQuery({
    queryKey: ['alarms', 'active', selectionKey],
    queryFn: fetchActiveAlarms,
    refetchInterval: ACTIVE_POLL_MS,
    refetchIntervalInBackground: true,
  })

  // The row, not the id: alarm ids come from each plant's own sequence, so the
  // acknowledge has to name which database it means.
  const ackMutation = useMutation({
    mutationFn: (alarm) => acknowledgeAlarm(alarm.id, alarm.datasource_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alarms', 'recent'] }),
  })

  const alarms = recentQuery.data?.alarms ?? []
  const sources = recentQuery.data?.sources ?? []
  const activeAlarms = activeQuery.data?.alarms ?? []
  const multiSource = sources.length > 1
  const loading = recentQuery.isLoading
  const error = recentQuery.error
    ? recentQuery.error?.response?.data?.detail || recentQuery.error?.message || String(recentQuery.error)
    : ''

  const hasActive = activeAlarms.length > 0

  // Keyed by source *and* location. Two plants routinely both call a line
  // "Line 1" and they are different physical lines; folding them into one band
  // would show an operator a single tag card mixing two machines' alarms. A Map
  // rather than the previous adjacency scan because the merged list is ordered
  // by location first, so one source's rows are not contiguous.
  const grouped = useMemo(() => {
    const byLocation = new Map()
    for (const row of alarms) {
      const location = row.location ?? UNKNOWN
      const tagName = row.tag_name ?? UNKNOWN
      const locKey = `${row.datasource_id ?? ''}::${location}`
      let loc = byLocation.get(locKey)
      if (!loc) {
        loc = {
          key: locKey,
          location,
          datasource_name: row.datasource_name ?? null,
          tags: new Map(),
          alarmCount: 0,
        }
        byLocation.set(locKey, loc)
      }
      let tag = loc.tags.get(tagName)
      if (!tag) {
        tag = {
          key: `${locKey}::${tagName}`,
          tag_name: tagName,
          alarms: [],
          severity: 'info',
          unacked: 0,
        }
        loc.tags.set(tagName, tag)
      }
      tag.alarms.push(row)
      const sev = row.severity || 'info'
      if ((SEV_RANK[sev] || 0) > (SEV_RANK[tag.severity] || 0)) {
        tag.severity = sev
      }
      if (!row.acknowledged) tag.unacked += 1
      loc.alarmCount += 1
    }
    return [...byLocation.values()].map((loc) => ({
      ...loc,
      tags: [...loc.tags.values()],
    }))
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
                key={`${al.datasource_id ?? ''}::${al.location}::${al.tag_name}::${al.alarm_no}`}
                className={`${styles['alm__active-card']} ${styles[`alm__active-card--${al.severity || 'info'}`]}`}
              >
                <div className={styles['alm__active-card-top']}>
                  <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${al.severity || 'info'}`]}`}>
                    {sevLabel(al.severity)}
                  </span>
                  <span className={styles['alm__active-value']}>{al.alarm_value ?? '—'}</span>
                </div>
                <span className={styles['alm__active-tag']}>{al.tag_name ?? '—'}</span>
                <span className={styles['alm__active-loc']}>
                  {al.location ?? '—'}
                  {multiSource && al.datasource_name ? ` · ${al.datasource_name}` : ''}
                </span>
                <p className={styles['alm__active-msg']}>{al.alarm ?? '—'}</p>
                <time className={styles['alm__active-time']}>{fmtTime(al.at_date_time)}</time>
              </article>
            ))}
          </div>
        </section>
      )}

      <SourceStatus sources={sources} />

      {error && <p className={styles['page__error']}>{error}</p>}
      {!error && loading && !alarms.length && (
        <p className={styles['page__empty']}>Loading alarms…</p>
      )}
      {!error && isEmpty && <p className={styles['page__empty']}>No alarms recorded.</p>}

      {grouped.map((loc) => (
        <section key={loc.key} className={styles['alm__loc']}>
          <header className={styles['alm__loc-head']}>
            <span className={styles['alm__loc-name']}>{loc.location}</span>
            {multiSource && loc.datasource_name && (
              <span className={styles['alm__source']}>{loc.datasource_name}</span>
            )}
            <span className={styles['alm__loc-meta']}>
              {loc.tags.length} {loc.tags.length === 1 ? 'tag' : 'tags'} · {loc.alarmCount}{' '}
              {loc.alarmCount === 1 ? 'alarm' : 'alarms'}
            </span>
          </header>

          <div className={styles['alm__stack']}>
            {loc.tags.map((tag) => {
              const key = tag.key
              const isOpen = expanded === key
              return (
                <article
                  key={key}
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
                        const isPending =
                          ackMutation.isPending &&
                          ackMutation.variables?.id === al.id &&
                          ackMutation.variables?.datasource_id === al.datasource_id
                        return (
                          <li
                            key={`${al.datasource_id ?? ''}::${al.id}`}
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
                                    onClick={() => ackMutation.mutate(al)}
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
