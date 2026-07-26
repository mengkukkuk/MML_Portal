import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Popover from '@mui/material/Popover'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import SettingsIcon from '@mui/icons-material/Settings'
import EditIcon from '@mui/icons-material/Edit'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CloseIcon from '@mui/icons-material/Close'
import EChart from '@/components/charts/EChart'
import { fetchSchemaValues } from '@/api/schema'
import { colorAt } from '@/utils/seriesPalette'
import {
  usePanelSeries, buildSeriesList, computeAlertSeries, POLL_INTERVALS, TIME_RANGES,
} from './usePanelSeries'
import { usePanelPolling } from './usePanelPolling'
import {
  buildGenericOption, buildGaugeOption, buildStatSparklineOption, buildTableRows,
  thresholdColor, fmtValue,
} from './options'
import styles from './LivePanel.module.css'

/**
 * LivePanel — a single self-polling tile in the Live dashboard grid.
 *
 * Chrome + render-tree only: all data derivation lives in usePanelSeries
 * (source dispatch, cartesian expansion, math transform, units) and
 * usePanelPolling (TanStack Query wrapper: 9-field key + refreshSignal,
 * seed/poll accumulator, retry-after-4s). This component wires the two
 * together into the hydrated seriesList, then switches on vizType to render
 * stat / table / gauge small-multiples or a single generic <EChart>.
 *
 * The panel-edit dialog itself is Phase 6 (PanelEditorDialog) — the gear
 * popover's Edit/Duplicate/Delete rows just forward to the onEdit/
 * onDuplicate/onDelete callback props, same as Vue's emit('edit', panel) etc.
 */
export default function LivePanel({
  panel,
  deviceName = '',
  canManage = false,
  // Narrower than canManage: operators may change poll interval without full
  // panel-edit rights (Edit/Duplicate/Delete still gate on canManage).
  canChangePollInterval = false,
  editMode = false,
  // Bumped by the Live page's Refresh button to force an immediate re-fetch.
  refreshSignal = 0,
  onEdit,
  onDuplicate,
  onDelete,
  onPollIntervalChange,
  onUpdated,
}) {
  // Time-range selector — view-only preference, not persisted to the panel
  // record, so any viewer can widen/narrow their own window independently.
  const [rangeMinutes, setRangeMinutes] = useState(10)
  // Series-value changer — view-only override of which single filter-column
  // value a table-source panel shows. null = "use the panel's configured value".
  const [filterOverride, setFilterOverride] = useState(null)
  // All per-panel controls collapse behind a single gear button (MUI Popover,
  // not Menu, since it hosts interactive Selects that shouldn't auto-close on
  // inner clicks).
  const [gearAnchor, setGearAnchor] = useState(null)
  const gearOpen = Boolean(gearAnchor)
  const closeGear = () => setGearAnchor(null)

  const {
    vizType, opts, isTag, isTable,
    tableValueCols, effectiveFilters, tableHasFilter, showFilterChanger,
    seriesSpecs, seriesTags, mathFn, isMulti, isGeneric, showHeaderValue, unitFor,
  } = usePanelSeries(panel, { filterOverride })

  const pollSeconds = panel.poll_interval_seconds || 5

  const {
    seriesPoints, seriesLatest, unit, error, isLoading, isFetching, isReseeding,
  } = usePanelPolling({
    panel, seriesSpecs, seriesTags, isTag, isTable, mathFn, rangeMinutes, refreshSignal, onUpdated,
  })

  // Hydrated view model for every renderer below: one entry per series with
  // its colour, resolved unit and live points/latest.
  const seriesList = useMemo(
    () => buildSeriesList(seriesSpecs, { seriesPoints, seriesLatest, unitFor, deviceUnit: unit }),
    [seriesSpecs, seriesPoints, seriesLatest, unitFor, unit],
  )

  // Series currently in alert — de-duped union of every true condition's
  // referenced series, recomputed each poll via the hydrated seriesList.
  const alertSeries = useMemo(() => computeAlertSeries(panel, seriesList), [panel.options, seriesList])

  // Single-value header (first/only series).
  const firstLatest = seriesLatest[seriesSpecs[0]?.key] || null
  const headerUnit = seriesList[0]?.unit || ''

  // One shared ECharts option object for the 9 "generic" viz types — pure
  // function, no hooks, memoized so <EChart notMerge> doesn't diff a fresh
  // object identity on every render that didn't actually change the data.
  const option = useMemo(
    () => (isGeneric ? buildGenericOption(vizType, seriesList, opts) : null),
    [isGeneric, vizType, seriesList, opts],
  )

  // statetimeline/heatmap grow with series count; every other generic viz
  // gets a fixed height (the panel__chart CSS class's flex-grow still lets
  // it fill remaining tile space beyond this).
  const chartHeight = useMemo(() => {
    if (vizType === 'statetimeline') return `${Math.max(120, seriesList.length * 44 + 40)}px`
    if (vizType === 'heatmap') return `${Math.max(160, seriesList.length * 34 + 60)}px`
    return '220px'
  }, [vizType, seriesList.length])

  const tableRows = useMemo(() => buildTableRows(seriesList, opts), [seriesList, opts])

  // Available values for the series-value changer — fetched once (view-only,
  // not polled), mirroring Vue's onMounted-only fetchSchemaValues call.
  const filtersQuery = useQuery({
    queryKey: ['live-panel-filter-values', panel.table_name, panel.filter_col, panel.datasource_id],
    queryFn: () => fetchSchemaValues(panel.table_name, panel.filter_col, 500, panel.datasource_id || undefined),
    enabled: showFilterChanger,
  })
  const availableFilters = filtersQuery.data || []

  const pollLabel = POLL_INTERVALS.find((it) => it.value === pollSeconds)?.label || `${pollSeconds}s`

  return (
    <article className={`${styles.panel} ${isReseeding ? styles['panel--reseeding'] : ''}`}>
      {/* Indeterminate bar pinned to the tile's top edge. Absolutely positioned
          so showing it never reflows the panel body — the values underneath
          stay exactly where they are while the new data lands. */}
      {(isLoading || isReseeding) && <span className={styles.panel__progress} aria-hidden="true" />}

      <header className={styles.panel__head}>
        <div className={styles.panel__titlewrap}>
          {editMode && canManage && (
            <button
              type="button"
              // "panel__drag" (unhashed, global) is load-bearing: react-grid-layout's
              // draggableHandle=".panel__drag" (LivePage.jsx) matches it via DOM
              // selector at runtime, which a CSS-Modules-hashed class name can't
              // satisfy. styles.panel__drag still supplies the visual styling.
              className={`${styles.panel__drag} panel__drag`}
              title="Drag to move"
              aria-label="Drag to move panel"
            >
              ⠿
            </button>
          )}
          <h3 className={styles.panel__title}>{panel.title}</h3>
        </div>

        <div className={styles.panel__actions}>
          {/* Heartbeat: proves the tile is live and states its cadence, so a
              steady value can't be mistaken for a frozen panel. */}
          <span
            className={`${styles.panel__live} ${isFetching ? styles['panel__live--busy'] : ''}`}
            title={`Live · refreshing every ${pollLabel}`}
          >
            <span className={styles.panel__livedot} />
            {pollLabel}
          </span>

          <button
            type="button"
            className={`${styles.panel__gear} ${gearOpen ? styles['panel__gear--active'] : ''}`}
            title="Panel settings"
            aria-label="Panel settings"
            onClick={(e) => setGearAnchor(e.currentTarget)}
          >
            <SettingsIcon fontSize="small" />
          </button>

          <Popover
            open={gearOpen}
            anchorEl={gearAnchor}
            onClose={closeGear}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { className: styles.gearpopPaper } }}
          >
            <div className={styles.gearpop}>
              {showFilterChanger && (
                <div className={styles.gearpop__row}>
                  <span className={styles.gearpop__label}>Series value</span>
                  <FormControl size="small" className={styles.gearpop__control}>
                    <Select
                      value={effectiveFilters[0] ?? ''}
                      onChange={(e) => setFilterOverride(e.target.value)}
                    >
                      {availableFilters.map((v) => (
                        <MenuItem key={v} value={v}>{v}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </div>
              )}

              <div className={styles.gearpop__row}>
                <span className={styles.gearpop__label}>Time range</span>
                <FormControl size="small" className={styles.gearpop__control}>
                  <Select
                    value={rangeMinutes}
                    onChange={(e) => setRangeMinutes(Number(e.target.value))}
                  >
                    {TIME_RANGES.map((it) => (
                      <MenuItem key={it.value} value={it.value}>{it.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>

              <div className={styles.gearpop__row}>
                <span className={styles.gearpop__label}>Poll interval</span>
                <FormControl size="small" className={styles.gearpop__control} disabled={!canChangePollInterval}>
                  <Select
                    value={pollSeconds}
                    disabled={!canChangePollInterval}
                    title={canChangePollInterval ? '' : 'Operator or admin only'}
                    onChange={(e) => onPollIntervalChange?.(panel, Number(e.target.value))}
                  >
                    {POLL_INTERVALS.map((it) => (
                      <MenuItem key={it.value} value={it.value}>{it.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>

              {canManage && (
                <>
                  <div className={styles.gearpop__divider} />
                  <button
                    type="button"
                    className={styles.gearpop__action}
                    onClick={() => { closeGear(); onEdit?.(panel) }}
                  >
                    <EditIcon fontSize="inherit" /> Edit panel
                  </button>
                  <button
                    type="button"
                    className={styles.gearpop__action}
                    onClick={() => { closeGear(); onDuplicate?.(panel) }}
                  >
                    <ContentCopyIcon fontSize="inherit" /> Duplicate
                  </button>
                  <button
                    type="button"
                    className={`${styles.gearpop__action} ${styles['gearpop__action--danger']}`}
                    onClick={() => { closeGear(); onDelete?.(panel) }}
                  >
                    <CloseIcon fontSize="inherit" /> Delete
                  </button>
                </>
              )}
            </div>
          </Popover>
        </div>
      </header>

      <span className={styles.panel__conn}>
        {isTable && (
          <>
            {panel.table_name}
            {tableHasFilter && ` · ${effectiveFilters.join(', ')}`}
            {` · ${tableValueCols.join(', ')}`}
          </>
        )}
        {!isTable && isTag && `tag · ${seriesTags.join(', ')} · ${panel.metric}`}
        {!isTable && !isTag && `${deviceName || `device #${panel.device_id}`} · ${panel.metric}`}
      </span>

      <div className={styles.panel__meta}>
        {showHeaderValue && (
          isMulti ? (
            seriesList.map((s, i) => (
              <span key={s.key} className={styles.panel__chip}>
                <span className={styles.panel__chipdot} style={{ background: colorAt(i) }} />
                {s.label}: {s.latest ? fmtValue(s.latest.value, opts.decimals) : '—'}{s.unit ? ` ${s.unit}` : ''}
              </span>
            ))
          ) : (
            <>
              <span className={styles.panel__num}>{firstLatest ? fmtValue(firstLatest.value, opts.decimals) : '—'}</span>
              <span className={styles.panel__unit}>{headerUnit}</span>
            </>
          )
        )}
      </div>

      {error && <p className={styles.panel__error}>{error}</p>}

      {alertSeries.length > 0 && (
        <div className={styles.panel__alert} role="status">
          {alertSeries.join(', ')} ALERTS
        </div>
      )}

      {vizType === 'stat' && (
        <div className={`${styles.panel__stat} ${isMulti ? styles['panel__stat--multi'] : ''}`}>
          {seriesList.map((s, i) => (
            <div key={s.key} className={styles.panel__statrow}>
              <div
                className={styles.panel__statnum}
                style={{ color: s.latest ? thresholdColor(s.latest.value, colorAt(i), opts.warn, opts.crit) : 'var(--fg)' }}
              >
                {s.latest ? fmtValue(s.latest.value, opts.decimals) : '—'}
                <span className={styles.panel__statunit}>{s.unit}</span>
              </div>
              {isMulti && (
                <span className={styles.panel__statlabel} style={{ color: colorAt(i) }}>{s.label}</span>
              )}
              {opts.sparkline !== false && !isMulti && (
                <EChart
                  key={`stat-${s.key}`}
                  className={styles.panel__spark}
                  height="64px"
                  option={buildStatSparklineOption(s, i)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {vizType === 'table' && (
        <div className={styles.panel__tablewrap}>
          <table className={styles.panel__table}>
            <thead>
              <tr>
                <th>Time</th>
                {seriesList.map((s, i) => (
                  <th key={s.key} style={{ color: isMulti ? colorAt(i) : undefined }}>
                    {s.label}{s.unit ? ` (${s.unit})` : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, k) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={k}>
                  <td>{row.t}</td>
                  {row.cells.map((c, ci) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <td key={ci}>{c}</td>
                  ))}
                </tr>
              ))}
              {!tableRows.length && (
                <tr>
                  <td colSpan={seriesList.length + 1} className={styles.panel__tableempty}>No data</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {vizType === 'gauge' && (
        <div className={`${styles.panel__minis} ${isMulti ? styles['panel__minis--multi'] : ''}`}>
          {seriesList.map((s, i) => (
            <div key={s.key} className={styles.panel__minicell}>
              <EChart
                key={`gauge-${s.key}`}
                className={`${styles.panel__minichart} ${isMulti ? styles['panel__minichart--multi'] : ''}`}
                option={buildGaugeOption(s, i, opts, isMulti)}
              />
              {isMulti && (
                <span className={styles.panel__minilabel} style={{ color: colorAt(i) }}>{s.label}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {isGeneric && (
        <EChart
          key={vizType}
          className={styles.panel__chart}
          height={chartHeight}
          option={option}
        />
      )}
    </article>
  )
}
