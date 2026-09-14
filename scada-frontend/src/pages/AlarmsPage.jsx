import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import CircularProgress from '@mui/material/CircularProgress'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import RefreshIcon from '@mui/icons-material/Refresh'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { fetchRecentAlarms, fetchActiveAlarms, acknowledgeAlarm } from '@/api/alarms'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { buildDefectLabelsByCode, resolveTagLabel } from '@/utils/defectLabels'
import { buildFamilies, sevRank } from '@/utils/alarmFamilies'
import { fmtStamp, fmtTime } from '@/utils/datetime'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import SourceStatus from '@/components/SourceStatus/SourceStatus.jsx'
import CollapseHeader, { CollapseMark } from '@/components/CollapseHeader/CollapseHeader.jsx'
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
 *
 * Date / line / tag filters mirror EventPage exactly — client-side, since
 * neither /alarms/recent nor /alarms/active takes filter params — and apply
 * to both the live "Active Alarms" grid and the historical stack below it,
 * each filtered from its own query's rows independently.
 */

const POLL_MS = 30_000
const ACTIVE_POLL_MS = 1_000
const UNKNOWN = 'Unknown'

function sevLabel(s) {
  return (s || 'info').toUpperCase()
}

/** The alarm_logs id to acknowledge. /alarms/recent rows call it `id`;
 * /alarms/active rows call the same column `alarm_id`, because there the row is
 * a tag joined to its triggering log entry and `id` would be ambiguous. */
function ackId(alarm) {
  return alarm.id ?? alarm.alarm_id
}

export default function AlarmsPage() {
  const queryClient = useQueryClient()
  const [perCard, setPerCard] = useState(10)
  // Three independent open-states, not one. The live grid and the historical
  // stack answer different questions ("what is wrong now" vs "what happened"),
  // so reading history must not collapse the live view out from under the
  // operator. Within each, single-open keeps the page height bounded — that is
  // the entire point of collapsing families in the first place.
  const [expandedActive, setExpandedActive] = useState(null) // family key in the Active grid
  const [expandedFamily, setExpandedFamily] = useState(null) // family key in the log stack
  const [expanded, setExpanded] = useState(null) // tag card in the log stack

  // A rejected acknowledge has to say so. The button sits in the live grid now,
  // where the 1 Hz poll would otherwise just redraw it and the click would look
  // like it was ignored.
  const [ackError, setAckError] = useState('')

  // Filters — same shape as EventPage's
  const [filterStartDate, setFilterStartDate] = useState(null) // dayjs | null
  const [filterEndDate, setFilterEndDate] = useState(null) // dayjs | null
  const [filterLocation, setFilterLocation] = useState('')
  const [filterTagName, setFilterTagName] = useState('')

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

  // Same query key the Monitor camera rail, Reports and Events use, so this
  // shares one cache entry with them. An unconfigured or errored camera
  // source just yields an empty map, and every tag keeps its raw defect_n name.
  const camerasQuery = useQuery({
    queryKey: ['camera-link-options'],
    queryFn: fetchCameraLinkOptions,
    staleTime: 60_000,
    retry: false,
  })
  const labelsByCode = useMemo(
    () => buildDefectLabelsByCode(camerasQuery.data?.cameras),
    [camerasQuery.data],
  )

  // The row, not the id: alarm ids come from each plant's own sequence, so the
  // acknowledge has to name which database it means. Both views feed this one
  // mutation, and they disagree on the field name — /alarms/recent calls the
  // log row's key `id`, /alarms/active calls the same column `alarm_id`.
  const ackMutation = useMutation({
    mutationFn: (alarm) => acknowledgeAlarm(ackId(alarm), alarm.datasource_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alarms', 'recent'] })
      queryClient.invalidateQueries({ queryKey: ['alarms', 'active'] })
    },
    onError: (e) =>
      setAckError(e?.response?.data?.detail || e?.message || 'Could not acknowledge that alarm.'),
  })

  const alarms = recentQuery.data?.alarms ?? []
  const sources = recentQuery.data?.sources ?? []
  const activeAlarms = activeQuery.data?.alarms ?? []
  const multiSource = sources.length > 1
  const loading = recentQuery.isLoading
  const error = recentQuery.error
    ? recentQuery.error?.response?.data?.detail || recentQuery.error?.message || String(recentQuery.error)
    : ''

  // Same four filters power both the live snapshot and the historical stack
  // below, so picking a Line/Tag/Date narrows what "currently in alarm" means,
  // not just what "recently happened" means.
  const filterRows = useCallback((rows) => {
    let out = rows
    if (filterStartDate) {
      const start = filterStartDate.toDate()
      start.setHours(0, 0, 0, 0)
      out = out.filter((r) => new Date(r.at_date_time) >= start)
    }
    if (filterEndDate) {
      const end = filterEndDate.toDate()
      end.setHours(23, 59, 59, 999)
      out = out.filter((r) => new Date(r.at_date_time) <= end)
    }
    if (filterLocation) {
      out = out.filter((r) => (r.location ?? UNKNOWN) === filterLocation)
    }
    if (filterTagName) {
      out = out.filter((r) => (r.tag_name ?? UNKNOWN) === filterTagName)
    }
    return out
  }, [filterStartDate, filterEndDate, filterLocation, filterTagName])

  const filteredActiveAlarms = useMemo(
    () => filterRows(activeAlarms),
    [filterRows, activeAlarms],
  )
  const hasActive = filteredActiveAlarms.length > 0

  // Every tag name the recent log knows about, used only as the stable
  // membership superset for family detection — see alarmFamilies.js. Without
  // it a family that drops to a single live alarm stops being a family, and
  // this grid repolls every second.
  const knownTagNames = useMemo(
    () => [...new Set(alarms.map((a) => a.tag_name ?? UNKNOWN))],
    [alarms],
  )

  // Collapses the active-alarm cards into one tile per tag-name family (every
  // CAM001-13-count_n / CAM001-13-defect_n card behind a single CAM001-13
  // tile), so the grid shows one row per camera instead of forty message cards.
  // A specific Tag filter bypasses grouping: wrapping the one tag the operator
  // explicitly asked for inside a collapsed container just adds a click.
  const activeFamilies = useMemo(() => buildFamilies({
    items: filteredActiveAlarms.map((al) => ({
      name: al.tag_name ?? UNKNOWN,
      severity: al.severity || 'info',
      location: al.location ?? null,
      latest: al.at_date_time,
      alarm: al,
    })),
    knownNames: knownTagNames,
    grouped: !filterTagName,
  }), [filteredActiveAlarms, knownTagNames, filterTagName])

  // Distinct location values for the Line filter dropdown
  const locationOptions = useMemo(() => {
    const set = new Set(alarms.map((a) => a.location ?? UNKNOWN))
    return [...set].sort()
  }, [alarms])

  // Distinct tag_name values — scoped to the selected location when set
  const tagOptions = useMemo(() => {
    const rows = filterLocation
      ? alarms.filter((a) => (a.location ?? UNKNOWN) === filterLocation)
      : alarms
    const set = new Set(rows.map((a) => a.tag_name ?? UNKNOWN))
    return [...set].sort()
  }, [alarms, filterLocation])

  // When location changes, reset tag filter if it no longer applies
  useEffect(() => {
    if (filterTagName && !tagOptions.includes(filterTagName)) {
      setFilterTagName('')
    }
  }, [filterLocation, tagOptions, filterTagName])

  // Keyed by source *and* location. Two plants routinely both call a line
  // "Line 1" and they are different physical lines; folding them into one band
  // would show an operator a single tag card mixing two machines' alarms. A Map
  // rather than the previous adjacency scan because the merged list is ordered
  // by location first, so one source's rows are not contiguous.
  const grouped = useMemo(() => {
    const rows = filterRows(alarms)

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
      if (sevRank(sev) > sevRank(tag.severity)) {
        tag.severity = sev
      }
      if (!row.acknowledged) tag.unacked += 1
      loc.alarmCount += 1
    }
    return [...byLocation.values()].map((loc) => {
      const tags = [...loc.tags.values()]
      const families = buildFamilies({
        items: tags.map((tag) => ({
          name: tag.tag_name,
          severity: tag.severity,
          count: tag.alarms.length,
          unacked: tag.unacked,
          latest: tag.alarms[0]?.at_date_time ?? null,
          tag,
        })),
        knownNames: knownTagNames,
        grouped: !filterTagName,
      })
      return { ...loc, tags, families }
    })
  }, [alarms, filterRows, knownTagNames, filterTagName])

  const hasActiveFilters = !!(filterStartDate || filterEndDate || filterLocation || filterTagName)
  const isEmpty = !loading && !error && grouped.length === 0
  const updatedLabel = recentQuery.dataUpdatedAt
    ? new Date(recentQuery.dataUpdatedAt).toLocaleTimeString()
    : '—'

  // Selecting a single tag is an explicit "show me exactly this", so the one
  // remaining card opens itself rather than making the operator click the
  // thing they just asked for. Keyed on the resolved card key, so the 30s poll
  // recomputing `grouped` does not re-open a card the operator has closed.
  const soleTagKey = useMemo(() => {
    if (!filterTagName) return null
    const keys = grouped.flatMap((loc) => loc.tags.map((tag) => tag.key))
    return keys.length === 1 ? keys[0] : null
  }, [filterTagName, grouped])

  useEffect(() => {
    if (soleTagKey) setExpanded(soleTagKey)
  }, [soleTagKey])

  function toggleCard(key) {
    setExpanded((cur) => (cur === key ? null : key))
  }

  function toggleActive(key) {
    setExpandedActive((cur) => (cur === key ? null : key))
  }

  function toggleFamily(key) {
    setExpandedFamily((cur) => (cur === key ? null : key))
  }

  // A family tile that clears entirely stops being rendered, which would leave
  // expandedActive pointing at a key that no longer exists — harmless for
  // rendering, but it would silently re-open the family if the same camera
  // alarmed again later. Dropping the key closes it instead, per "the poll
  // never changes what is open".
  useEffect(() => {
    if (expandedActive && !activeFamilies.some((fam) => fam.key === expandedActive)) {
      setExpandedActive(null)
    }
  }, [activeFamilies, expandedActive])

  /** Collapsed summary of one family in the Active grid. The alarm message is
   * deliberately absent: it is what makes the expanded card 180px tall, and at
   * the overview level the question is which camera is unhappy and how badly,
   * not what each tag said. */
  function renderActiveFamily(fam) {
    const isOpen = expandedActive === fam.key
    const panelId = `alm-active-${fam.key}`
    return (
      <article
        key={fam.key}
        className={`${styles['alm__active-group']} ${
          styles[`alm__active-group--${fam.severity}`]
        } ${isOpen ? styles['alm__active-group--open'] : ''}`}
      >
        <CollapseHeader
          open={isOpen}
          controls={panelId}
          className={styles['alm__active-group-head']}
          onToggle={() => toggleActive(fam.key)}
        >
          <div className={styles['alm__active-group-top']}>
            <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${fam.severity}`]}`}>
              {sevLabel(fam.severity)}
            </span>
            {fam.total > 1 && <span className={styles['alm__badge']}>{fam.total}</span>}
            <CollapseMark open={isOpen} />
          </div>
          <span className={styles['alm__active-group-name']}>
            {fam.isGroup ? fam.key : resolveTagLabel(fam.key, fam.location, labelsByCode)}
          </span>
          <span className={styles['alm__active-group-meta']}>
            {fam.location ?? '—'} · {fmtTime(fam.latest)}
          </span>
        </CollapseHeader>
        {isOpen && (
          <div id={panelId} className={styles['alm__active-group-body']}>
            {fam.members.map((member) => renderActiveCard(member.alarm))}
          </div>
        )}
      </article>
    )
  }

  /** Collapsed summary of one family in the historical log stack. */
  function renderFamilyRow(fam, loc) {
    const key = `${loc.key}::${fam.key}`
    const isOpen = expandedFamily === key
    const panelId = `alm-family-${key}`
    return (
      <div key={key} className={styles['alm__family']}>
        <CollapseHeader
          open={isOpen}
          controls={panelId}
          className={`${styles['alm__family-head']} ${styles[`alm__family-head--${fam.severity}`]}`}
          onToggle={() => toggleFamily(key)}
        >
          <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${fam.severity}`]}`}>
            {sevLabel(fam.severity)}
          </span>
          <span className={styles['alm__family-name']}>{fam.key}</span>
          <span className={styles['alm__family-meta']}>
            {fam.tagCount} {fam.tagCount === 1 ? 'tag' : 'tags'} · {fam.total}{' '}
            {fam.total === 1 ? 'alarm' : 'alarms'}
          </span>
          <div className={styles['alm__tag-actions']}>
            {fam.unacked > 0 && (
              <span
                className={`${styles['alm__badge']} ${styles['alm__badge--unacked']}`}
                title={`${fam.unacked} unacknowledged`}
              >
                {fam.unacked}
              </span>
            )}
            <span className={styles['alm__badge']}>{fam.total}</span>
            <CollapseMark open={isOpen} />
          </div>
        </CollapseHeader>
        {isOpen && (
          <div id={panelId} className={styles['alm__family-body']}>
            {fam.members.map((member) => renderTagCard(member.tag, loc))}
          </div>
        )}
      </div>
    )
  }

  /** Acknowledge affordance for one alarm row, shared by the live grid and the
   * historical timeline. Acknowledging never clears an alarm, so an acked row
   * stays put and swaps the button for a pill rather than disappearing. */
  function renderAckControl(al) {
    if (al.acknowledged) {
      return (
        <span
          className={styles['alm__ack-pill']}
          title={al.acknowledged_at ? `Acknowledged ${fmtTime(al.acknowledged_at)}` : 'Acknowledged'}
        >
          Ack
        </span>
      )
    }
    // Compared by id *and* source: the same id is a different alarm in another
    // plant, so matching on id alone would spin every plant's button at once.
    const pending =
      ackMutation.isPending &&
      ackId(ackMutation.variables ?? {}) === ackId(al) &&
      ackMutation.variables?.datasource_id === al.datasource_id
    return (
      <button
        type="button"
        className={styles['alm__ack-btn']}
        disabled={pending}
        aria-label={`Acknowledge ${al.tag_name ?? 'alarm'}`}
        onClick={() => {
          setAckError('')
          ackMutation.mutate(al)
        }}
      >
        {pending ? <CircularProgress size={10} color="inherit" /> : 'Acknowledge'}
      </button>
    )
  }

  function renderActiveCard(al) {
    return (
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
        <span className={styles['alm__active-tag']}>
          {resolveTagLabel(al.tag_name, al.location, labelsByCode) ?? '—'}
        </span>
        <span className={styles['alm__active-loc']}>
          {al.location ?? '—'}
          {multiSource && al.datasource_name ? ` · ${al.datasource_name}` : ''}
        </span>
        <p className={styles['alm__active-msg']}>{al.alarm ?? '—'}</p>
        <div className={styles['alm__active-foot']}>
          {/* Compact stamp: the full locale datetime beside the button needs ~238px,
              and the grid's narrowest column leaves 208px, so it would always wrap. */}
          <time className={styles['alm__active-time']} title={fmtTime(al.at_date_time)}>
            {fmtStamp(al.at_date_time)}
          </time>
          {renderAckControl(al)}
        </div>
      </article>
    )
  }

  function renderTagCard(tag, loc) {
    const key = tag.key
    const isOpen = expanded === key
    return (
      <article
        key={key}
        className={`${styles['alm__tag']} ${styles[`alm__tag--${tag.severity}`]} ${
          !isOpen ? styles['alm__tag--collapsed'] : ''
        }`}
      >
        <CollapseHeader
          open={isOpen}
          controls={`alm-tag-${key}`}
          className={styles['alm__tag-head']}
          onToggle={() => toggleCard(key)}
        >
          <span className={`${styles['alm__sev-pill']} ${styles[`alm__sev-pill--${tag.severity}`]}`}>
            {sevLabel(tag.severity)}
          </span>
          <span className={styles['alm__tag-name']}>
            {resolveTagLabel(tag.tag_name, loc.location, labelsByCode)}
          </span>
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
            <CollapseMark open={isOpen} />
          </div>
        </CollapseHeader>
        {isOpen && (
          <ol id={`alm-tag-${key}`} className={styles['alm__timeline']}>
            {tag.alarms.map((al, i) => (
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
                    {renderAckControl(al)}
                  </div>
                  <time className={styles['alm__time']}>{fmtTime(al.at_date_time)}</time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </article>
    )
  }

  function handleRefresh() {
    recentQuery.refetch()
    activeQuery.refetch()
  }

  function clearFilters() {
    setFilterStartDate(null)
    setFilterEndDate(null)
    setFilterLocation('')
    setFilterTagName('')
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

      {/* Filter bar — mirrors EventPage's exactly */}
      <div className={styles['alm__filterbar']}>
        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <div className={styles['alm__filter-group']}>
            <span className={styles['alm__filter-label']}>Date</span>
            <DatePicker
              value={filterStartDate}
              onChange={setFilterStartDate}
              format="DD/MM/YYYY"
              slotProps={{
                textField: { size: 'small', placeholder: 'Start date', className: styles['alm__date-picker'] },
                field: { clearable: true },
              }}
            />
            <span className={styles['alm__filter-sep']}>–</span>
            <DatePicker
              value={filterEndDate}
              onChange={setFilterEndDate}
              format="DD/MM/YYYY"
              slotProps={{
                textField: { size: 'small', placeholder: 'End date', className: styles['alm__date-picker'] },
                field: { clearable: true },
              }}
            />
          </div>
        </LocalizationProvider>

        <div className={styles['alm__filter-group']}>
          <span className={styles['alm__filter-label']}>Line</span>
          <FormControl size="small" className={styles['alm__filter-select']}>
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

        <div className={styles['alm__filter-group']}>
          <span className={styles['alm__filter-label']}>Tag</span>
          <FormControl size="small" className={styles['alm__filter-select']}>
            <Select
              value={filterTagName}
              displayEmpty
              onChange={(e) => setFilterTagName(e.target.value)}
            >
              <MenuItem value="">All tags</MenuItem>
              {tagOptions.map((tag) => (
                <MenuItem key={tag} value={tag}>
                  {resolveTagLabel(tag, filterLocation, labelsByCode)}
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

      {hasActive && (
        <section className={styles['alm__active']}>
          <header className={styles['alm__active-head']}>
            <span className={styles['alm__active-dot']} aria-hidden="true" />
            <span className={styles['alm__active-title']}>Active Alarms</span>
            <span className={styles['alm__active-count']}>{filteredActiveAlarms.length} active</span>
          </header>
          <div className={styles['alm__active-grid']}>
            {filterTagName
              ? filteredActiveAlarms.map((al) => renderActiveCard(al))
              : activeFamilies.map((fam) => renderActiveFamily(fam))}
          </div>
        </section>
      )}

      <SourceStatus sources={sources} />

      {error && <p className={styles['page__error']}>{error}</p>}
      {!error && loading && !alarms.length && (
        <p className={styles['page__empty']}>Loading alarms…</p>
      )}
      {!error && isEmpty && (
        <p className={styles['page__empty']}>
          {hasActiveFilters ? 'No alarms match the current filters.' : 'No alarms recorded.'}
        </p>
      )}

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
            {loc.families.map((fam) => (
              fam.isGroup
                ? renderFamilyRow(fam, loc)
                : fam.members.map((member) => renderTagCard(member.tag, loc))
            ))}
          </div>
        </section>
      ))}

      {/* Pinned rather than inline: the same button exists in the live grid at
          the top and in a tag timeline far below it, so there is no one spot on
          the page that is near whichever one the operator just clicked. */}
      <Snackbar
        open={!!ackError}
        autoHideDuration={6000}
        onClose={() => setAckError('')}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setAckError('')} sx={{ width: '100%' }}>
          {ackError}
        </Alert>
      </Snackbar>
    </div>
  )
}
