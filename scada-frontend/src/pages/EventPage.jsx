import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import RefreshIcon from '@mui/icons-material/Refresh'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { fetchRecentEvents } from '@/api/events'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import SourceStatus from '@/components/SourceStatus/SourceStatus.jsx'
import styles from './EventPage.module.css'

/**
 * EventPage — discrete event log viewer (route: /events).
 * Reads public.event_logs via /api/events/recent and renders a
 * location -> tag_name -> events tree: each location is a band, each tag_name a
 * card, each card a timeline of its last N events (newest first).
 * Auto-polls every 30s (POLL_MS) via TanStack Query's refetchInterval, with
 * refetchIntervalInBackground so a backgrounded wall-display tab keeps
 * polling. The per-card count (5 / 10 / 25, `perCard`) is the only knob the
 * backend actually understands (GET /events/recent?limit=), so it drives the
 * query key; date range / line / tag name are client-side filters over the
 * fetched window (`/api/events/recent` has no server-side filter params —
 * see src/api/events.js — so this mirrors the Vue version's behavior
 * exactly rather than inventing unsupported query params).
 */

const POLL_MS = 30_000
const UNKNOWN = 'Unknown'

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

export default function EventPage() {
  const [perCard, setPerCard] = useState(10)
  const [expanded, setExpanded] = useState(null) // key of currently open card, null = all collapsed

  // Filters
  const [filterStartDate, setFilterStartDate] = useState(null) // dayjs | null
  const [filterEndDate, setFilterEndDate] = useState(null) // dayjs | null
  const [filterLocation, setFilterLocation] = useState('')
  const [filterTagName, setFilterTagName] = useState('')

  // selectionKey is part of the key, not just an invalidation trigger: the rows
  // are merged from whichever plants are selected, so a different selection is a
  // different result set rather than a stale one.
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const eventsQuery = useQuery({
    queryKey: ['events', 'recent', perCard, selectionKey],
    queryFn: () => fetchRecentEvents(perCard),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  })

  const events = eventsQuery.data?.events ?? []
  const sources = eventsQuery.data?.sources ?? []
  const multiSource = sources.length > 1
  const loading = eventsQuery.isLoading
  const error = eventsQuery.error
    ? eventsQuery.error?.response?.data?.detail || eventsQuery.error?.message || String(eventsQuery.error)
    : ''

  // Distinct location values for the Line filter dropdown
  const locationOptions = useMemo(() => {
    const set = new Set(events.map((e) => e.location ?? UNKNOWN))
    return [...set].sort()
  }, [events])

  // Distinct tag_name values — scoped to the selected location when set
  const tagOptions = useMemo(() => {
    const rows = filterLocation
      ? events.filter((e) => (e.location ?? UNKNOWN) === filterLocation)
      : events
    const set = new Set(rows.map((e) => e.tag_name ?? UNKNOWN))
    return [...set].sort()
  }, [events, filterLocation])

  // When location changes, reset tag filter if it no longer applies
  useEffect(() => {
    if (filterTagName && !tagOptions.includes(filterTagName)) {
      setFilterTagName('')
    }
  }, [filterLocation, tagOptions, filterTagName])

  // Fold the flat, pre-ordered list (location, tag_name, at_date_time DESC) into
  // a location -> tags -> events tree in a single pass, after applying active filters.
  const grouped = useMemo(() => {
    let rows = events

    if (filterStartDate) {
      const start = filterStartDate.toDate()
      start.setHours(0, 0, 0, 0)
      rows = rows.filter((e) => new Date(e.at_date_time) >= start)
    }
    if (filterEndDate) {
      const end = filterEndDate.toDate()
      end.setHours(23, 59, 59, 999)
      rows = rows.filter((e) => new Date(e.at_date_time) <= end)
    }
    if (filterLocation) {
      rows = rows.filter((e) => (e.location ?? UNKNOWN) === filterLocation)
    }
    if (filterTagName) {
      rows = rows.filter((e) => (e.tag_name ?? UNKNOWN) === filterTagName)
    }

    // Keyed by source *and* location, not location alone. Two plants routinely
    // both call a line "Line 1", and they are different physical lines — folding
    // them into one band would merge unrelated machines into a single timeline.
    // A Map rather than the previous adjacency scan because the merged list is
    // ordered by location first, so one source's rows are not contiguous.
    const byLocation = new Map()
    for (const row of rows) {
      const location = row.location ?? UNKNOWN
      const tagName = row.tag_name ?? UNKNOWN
      const locKey = `${row.datasource_id ?? ''}::${location}`
      let loc = byLocation.get(locKey)
      if (!loc) {
        loc = {
          key: locKey,
          location,
          datasource_id: row.datasource_id ?? null,
          datasource_name: row.datasource_name ?? null,
          tags: new Map(),
          eventCount: 0,
        }
        byLocation.set(locKey, loc)
      }
      let tag = loc.tags.get(tagName)
      if (!tag) {
        tag = { key: `${locKey}::${tagName}`, tag_name: tagName, events: [] }
        loc.tags.set(tagName, tag)
      }
      tag.events.push(row)
      loc.eventCount += 1
    }
    return [...byLocation.values()].map((loc) => ({
      ...loc,
      tags: [...loc.tags.values()],
    }))
  }, [events, filterStartDate, filterEndDate, filterLocation, filterTagName])

  const hasActiveFilters = !!(filterStartDate || filterEndDate || filterLocation || filterTagName)
  const isEmpty = !loading && !error && grouped.length === 0
  const updatedLabel = eventsQuery.dataUpdatedAt
    ? new Date(eventsQuery.dataUpdatedAt).toLocaleTimeString()
    : '—'

  function toggleCard(key) {
    setExpanded((cur) => (cur === key ? null : key))
  }

  function clearFilters() {
    setFilterStartDate(null)
    setFilterEndDate(null)
    setFilterLocation('')
    setFilterTagName('')
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div className={styles.page}>
        <header className={styles['page__head']}>
          <h2 className={styles['page__title']}>Events</h2>
          <div className={styles['page__controls']}>
            <span className={styles['evt__updated']}>
              <span
                className={`${styles['evt__dot']} ${!error ? styles['evt__dot--live'] : ''}`}
                aria-hidden="true"
              />
              Updated {updatedLabel}
            </span>
            <FormControl size="small" className={styles['evt__select']}>
              <Select value={perCard} onChange={(e) => setPerCard(Number(e.target.value))}>
                <MenuItem value={5}>Last 5</MenuItem>
                <MenuItem value={10}>Last 10</MenuItem>
                <MenuItem value={25}>Last 25</MenuItem>
              </Select>
            </FormControl>
            <Button
              startIcon={<RefreshIcon />}
              loading={eventsQuery.isFetching}
              onClick={() => eventsQuery.refetch()}
            >
              Refresh
            </Button>
          </div>
        </header>

        {/* Filter bar */}
        <div className={styles['evt__filterbar']}>
          <div className={styles['evt__filter-group']}>
            <span className={styles['evt__filter-label']}>Date</span>
            <DatePicker
              value={filterStartDate}
              onChange={setFilterStartDate}
              format="DD/MM/YYYY"
              slotProps={{
                textField: { size: 'small', placeholder: 'Start date', className: styles['evt__date-picker'] },
                field: { clearable: true },
              }}
            />
            <span className={styles['evt__filter-sep']}>–</span>
            <DatePicker
              value={filterEndDate}
              onChange={setFilterEndDate}
              format="DD/MM/YYYY"
              slotProps={{
                textField: { size: 'small', placeholder: 'End date', className: styles['evt__date-picker'] },
                field: { clearable: true },
              }}
            />
          </div>

          <div className={styles['evt__filter-group']}>
            <span className={styles['evt__filter-label']}>Line</span>
            <FormControl size="small" className={styles['evt__filter-select']}>
              <Select
                value={filterLocation}
                displayEmpty
                onChange={(e) => setFilterLocation(e.target.value)}
              >
                <MenuItem value="">All lines</MenuItem>
                {locationOptions.map((loc) => (
                  <MenuItem key={loc} value={loc}>
                    {loc}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </div>

          <div className={styles['evt__filter-group']}>
            <span className={styles['evt__filter-label']}>Tag</span>
            <FormControl size="small" className={styles['evt__filter-select']}>
              <Select
                value={filterTagName}
                displayEmpty
                onChange={(e) => setFilterTagName(e.target.value)}
              >
                <MenuItem value="">All tags</MenuItem>
                {tagOptions.map((tag) => (
                  <MenuItem key={tag} value={tag}>
                    {tag}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </div>

          {hasActiveFilters && (
            <Button size="small" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>

        <SourceStatus sources={sources} />

        {error && <p className={styles['page__error']}>{error}</p>}
        {!error && loading && !events.length && (
          <p className={styles['page__empty']}>Loading events…</p>
        )}
        {!error && isEmpty && (
          <p className={styles['page__empty']}>
            {hasActiveFilters ? 'No events match the current filters.' : 'No events recorded.'}
          </p>
        )}

        {grouped.map((loc) => (
          <section key={loc.key} className={styles['evt__loc']}>
            <header className={styles['evt__loc-head']}>
              <span className={styles['evt__loc-name']}>{loc.location}</span>
              {multiSource && loc.datasource_name && (
                <span className={styles['evt__source']}>{loc.datasource_name}</span>
              )}
              <span className={styles['evt__loc-meta']}>
                {loc.tags.length} {loc.tags.length === 1 ? 'tag' : 'tags'} · {loc.eventCount}{' '}
                {loc.eventCount === 1 ? 'event' : 'events'}
              </span>
            </header>

            <div className={styles['evt__stack']}>
              {loc.tags.map((tag) => {
                const key = tag.key
                const isOpen = expanded === key
                return (
                  <article
                    key={key}
                    className={`${styles['evt__tag']} ${!isOpen ? styles['evt__tag--collapsed'] : ''}`}
                  >
                    <header className={styles['evt__tag-head']} onClick={() => toggleCard(key)}>
                      <span className={styles['evt__tag-name']}>{tag.tag_name}</span>
                      <div className={styles['evt__tag-actions']}>
                        <span className={styles['evt__badge']}>{tag.events.length}</span>
                        <button
                          type="button"
                          className={styles['evt__minimize']}
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
                      <ol className={styles['evt__timeline']}>
                        {tag.events.map((ev, i) => (
                          <li
                            key={`${ev.at_date_time}::${ev.event}::${i}`}
                            className={`${styles['evt__item']} ${i === 0 ? styles['evt__item--latest'] : ''}`}
                          >
                            <span className={styles['evt__node']} aria-hidden="true" />
                            <div className={styles['evt__body']}>
                              <span className={styles['evt__text']}>{ev.event ?? '—'}</span>
                              <time className={styles['evt__time']}>{fmtTime(ev.at_date_time)}</time>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </LocalizationProvider>
  )
}
