import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import Alert from '@mui/material/Alert'
import Chip from '@mui/material/Chip'
import TextField from '@mui/material/TextField'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { fetchAccessActive, fetchAccessHistory, fetchAccessStatus } from '@/api/access'
import { apiErrorMessage } from '@/api/client'
import { useTranslation } from '@/i18n'
import styles from './AccessView.module.css'

/**
 * AccessView — the "Access" view of the Accounts page (route: /accounts?view=access, admin only):
 * who reached this host, and for how long.
 * Backed by the network-access monitor in the API process: web traffic through IIS
 * and Remote Desktop. "Connected now" polls every few seconds and its durations tick
 * on the client against the server's clock; history is a time-range query over the
 * daily conn_monitor.log files. Protocol chips and the search box filter the fetched
 * window on the client, so typing never hits the API.
 *
 * Identity is remote IP + computer name, not a portal login.
 */

const ACTIVE_POLL_MS = 3_000
const STATUS_POLL_MS = 10_000
const HISTORY_POLL_MS = 30_000
const HISTORY_LIMIT = 5000
const DISPLAY_CAP = 500 // rendering thousands of rows would freeze the tab
const MAX_RANGE_DAYS = 31 // mirrors access.MAX_RANGE_DAYS on the server
const FALLBACK_PROTOCOLS = ['HTTPS', 'HTTP', 'RDP']

const PRESETS = [
  { id: 'hour', label: 'Last hour' },
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
]

function presetRange(id) {
  const now = dayjs()
  switch (id) {
    case 'hour':
      return [now.subtract(1, 'hour'), now]
    case '24h':
      return [now.subtract(24, 'hour'), now]
    case '7d':
      return [now.subtract(7, 'day'), now]
    case '30d':
      return [now.subtract(30, 'day'), now]
    default:
      return [now.startOf('day'), now]
  }
}

const pad = (n) => String(n).padStart(2, '0')

function fmtDur(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

function fmtTotal(seconds) {
  const mins = Math.floor(seconds / 60)
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
}

const fmtStamp = (value) => (value ? dayjs(value).format('DD/MM/YYYY HH:mm:ss') : '—')

function ProtocolTag({ protocol }) {
  const cls = styles[`tag${protocol}`] ?? ''
  return <span className={`${styles.tag} ${cls}`}>{protocol}</span>
}

export default function AccessView() {
  const tr = useTranslation()

  const [preset, setPreset] = useState('today') // null = custom range
  const [[start, end], setRange] = useState(() => presetRange('today'))
  const [protocol, setProtocol] = useState('All')
  const [search, setSearch] = useState('')
  const followNow = preset !== null

  const statusQuery = useQuery({
    queryKey: ['access', 'status'],
    queryFn: fetchAccessStatus,
    refetchInterval: STATUS_POLL_MS,
    refetchIntervalInBackground: true,
  })
  const activeQuery = useQuery({
    queryKey: ['access', 'active'],
    queryFn: fetchAccessActive,
    refetchInterval: ACTIVE_POLL_MS,
    refetchIntervalInBackground: true,
  })

  const rangeTooLong = end.diff(start, 'day', true) > MAX_RANGE_DAYS
  const rangeInverted = end.isBefore(start)
  const rangeOk = !rangeTooLong && !rangeInverted

  const historyQuery = useQuery({
    // A preset re-resolves "now" on every fetch; a custom range is pinned.
    queryKey: ['access', 'history', followNow ? preset : [start.valueOf(), end.valueOf()]],
    queryFn: () => {
      const [s, e] = followNow ? presetRange(preset) : [start, end]
      return fetchAccessHistory({ start: s, end: e, limit: HISTORY_LIMIT })
    },
    enabled: rangeOk,
    refetchInterval: followNow ? HISTORY_POLL_MS : false,
    refetchIntervalInBackground: true,
    placeholderData: (previous) => previous,
  })

  // Live durations tick against the server's clock, not the browser's.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const clockOffset = useMemo(() => {
    const serverMs = activeQuery.data ? new Date(activeQuery.data.server_time).getTime() : NaN
    return Number.isNaN(serverMs) ? 0 : serverMs - activeQuery.dataUpdatedAt
  }, [activeQuery.data, activeQuery.dataUpdatedAt])

  const status = statusQuery.data
  const active = activeQuery.data?.sessions ?? []
  const history = historyQuery.data
  const rows = useMemo(() => history?.rows ?? [], [history])

  const protocols = useMemo(() => {
    const labels = [...new Set((status?.ports ?? []).map((p) => p.label))]
    return ['All', ...(labels.length ? labels : FALLBACK_PROTOCOLS)]
  }, [status])

  const q = search.trim().toLowerCase()
  const visibleActive = useMemo(
    () => active.filter((a) => protocol === 'All' || a.protocol === protocol),
    [active, protocol],
  )
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (protocol === 'All' || r.protocol === protocol) &&
          (!q || [r.computer_name, r.remote_ip, r.protocol].join(' ').toLowerCase().includes(q)),
      ),
    [rows, protocol, q],
  )
  const shown = filtered.slice(0, DISPLAY_CAP)

  const stats = useMemo(() => {
    const rdp = rows.filter((r) => r.protocol === 'RDP').length
    return {
      sessions: history?.total ?? 0,
      rdp,
      web: rows.length - rdp,
      pcs: new Set(rows.map((r) => r.remote_ip)).size,
      seconds: rows.reduce((sum, r) => sum + r.seconds, 0),
    }
  }, [rows, history])

  function selectPreset(id) {
    setPreset(id)
    setRange(presetRange(id))
  }
  function changeStart(value) {
    if (!value?.isValid()) return
    setPreset(null)
    setRange(([, e]) => [value, e])
  }
  function changeEnd(value) {
    if (!value?.isValid()) return
    setPreset(null)
    setRange(([s]) => [s, value])
  }

  const monitorState = !status
    ? tr('Loading…')
    : !status.enabled
      ? tr('Monitor disabled')
      : status.running
        ? tr('Monitor running')
        : tr('Monitor not responding')
  const monitorOk = Boolean(status?.enabled && status?.running)

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <div className={styles.sub}>
            <span className={`${styles.dot} ${monitorOk ? styles.dotOn : styles.dotOff}`} />
            {monitorState}
            {status?.since ? ` · ${tr('since')} ${fmtStamp(status.since)}` : ''}
            {status?.ports?.length
              ? ` · ${tr('watching')} ${status.ports.map((p) => `${p.label} ${p.port}`).join(', ')}`
              : ''}
          </div>
        </div>
      </header>

      {status && !monitorOk && (
        <Alert severity="warning">
          {status.enabled
            ? tr('The monitor is not running, so new connections are not being recorded. Check the API service log.')
            : tr('The monitor is switched off (NETACCESS_ENABLED=0). Existing history is still shown.')}
        </Alert>
      )}

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>{tr('Connected now')}</div>
          <div className={styles.statValue}>{active.length}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>{tr('Sessions')}</div>
          <div className={styles.statValue}>{stats.sessions}</div>
          <div className={styles.statSub}>
            RDP {stats.rdp} · {tr('Web')} {stats.web}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>{tr('Unique PCs')}</div>
          <div className={styles.statValue}>{stats.pcs}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>{tr('Total time')}</div>
          <div className={styles.statValue}>{fmtTotal(stats.seconds)}</div>
        </div>
      </div>

      <section className={styles.card}>
        <h2 className={styles.cardHead}>{tr('Connected now')}</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{tr('Computer name')}</th>
                <th>{tr('Remote IP')}</th>
                <th>{tr('Protocol')}</th>
                <th>{tr('Port')}</th>
                <th>{tr('Connected since')}</th>
                <th>{tr('Duration')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleActive.map((a) => (
                <tr key={`${a.port}|${a.remote_ip}`}>
                  <td>{a.computer_name}</td>
                  <td className={styles.mono}>{a.remote_ip}</td>
                  <td>
                    <ProtocolTag protocol={a.protocol} />
                  </td>
                  <td>{a.port}</td>
                  <td>{fmtStamp(a.connected_since)}</td>
                  <td className={styles.live}>
                    {fmtDur((nowMs + clockOffset - new Date(a.connected_since).getTime()) / 1000)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visibleActive.length && <div className={styles.empty}>{tr('No one is connected.')}</div>}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{tr('History')}</h2>
          <div className={styles.tools}>
            <TextField
              size="small"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('Search name / IP / protocol')}
              inputProps={{ 'aria-label': tr('Search name / IP / protocol') }}
            />
          </div>
        </div>

        <div className={styles.filters}>
          <div className={styles.chips}>
            {PRESETS.map((p) => (
              <Chip
                key={p.id}
                size="small"
                label={tr(p.label)}
                color={preset === p.id ? 'primary' : 'default'}
                variant={preset === p.id ? 'filled' : 'outlined'}
                onClick={() => selectPreset(p.id)}
              />
            ))}
          </div>
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <div className={styles.range}>
              <DateTimePicker
                label={tr('From')}
                value={start}
                onChange={changeStart}
                maxDateTime={end}
                format="DD/MM/YYYY HH:mm"
                ampm={false}
                slotProps={{ textField: { size: 'small' } }}
              />
              <span className={styles.sep}>–</span>
              <DateTimePicker
                label={tr('To')}
                value={end}
                onChange={changeEnd}
                minDateTime={start}
                format="DD/MM/YYYY HH:mm"
                ampm={false}
                slotProps={{ textField: { size: 'small' } }}
              />
              {followNow && <span className={styles.liveBadge}>{tr('to now')}</span>}
            </div>
          </LocalizationProvider>
          <div className={styles.chips}>
            {protocols.map((p) => (
              <Chip
                key={p}
                size="small"
                label={p === 'All' ? tr('All') : p}
                color={protocol === p ? 'primary' : 'default'}
                variant={protocol === p ? 'filled' : 'outlined'}
                onClick={() => setProtocol(p)}
              />
            ))}
          </div>
        </div>

        {rangeInverted && <Alert severity="error">{tr('The end of the range is before its start.')}</Alert>}
        {rangeTooLong && (
          <Alert severity="error">{tr('Pick a range of 31 days or less.')}</Alert>
        )}
        {historyQuery.isError && rangeOk && <Alert severity="error">{apiErrorMessage(historyQuery.error)}</Alert>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{tr('Computer name')}</th>
                <th>{tr('Remote IP')}</th>
                <th>{tr('Protocol')}</th>
                <th>{tr('Start')}</th>
                <th>{tr('End')}</th>
                <th>{tr('Duration')}</th>
                <th>{tr('Note')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.start}|${r.remote_ip}|${r.port}|${i}`}>
                  <td>{r.computer_name}</td>
                  <td className={styles.mono}>{r.remote_ip}</td>
                  <td>
                    <ProtocolTag protocol={r.protocol} />
                  </td>
                  <td>{fmtStamp(r.start)}</td>
                  <td>{fmtStamp(r.end)}</td>
                  <td className={styles.live}>{r.duration}</td>
                  <td className={styles.note}>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!shown.length && !historyQuery.isFetching && (
          <div className={styles.empty}>{tr('No sessions in this range.')}</div>
        )}

        <footer className={styles.foot}>
          {history?.truncated && (
            <span className={styles.warn}>
              {tr('Showing the newest {shown} of {total} sessions. Narrow the range to see the rest.', {
                shown: history.rows.length,
                total: history.total,
              })}
            </span>
          )}
          {filtered.length > DISPLAY_CAP && (
            <span className={styles.warn}>
              {tr('Showing the first {cap} matches. Narrow the filters to see the rest.', { cap: DISPLAY_CAP })}
            </span>
          )}
          {history?.files?.length ? (
            <span>
              {tr('Log files')}: {history.files.join(', ')}
            </span>
          ) : (
            <span>{tr('No log files cover this range.')}</span>
          )}
        </footer>
      </section>
    </div>
  )
}
