import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import Button from '@mui/material/Button'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { TREND_RANGES, windowError } from './trendWindow'
import { useQuery } from '@tanstack/react-query'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import { fetchSchemaTables } from '@/api/schema'
import { fetchDatasources } from '@/api/datasources'
import { apiErrorMessage } from '@/api/client'
import { useTrendColumns } from './useTrendColumns'
import { trendSourceId } from './trendParams'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { useTranslation } from '@/i18n'
import styles from './TrendRail.module.css'

/**
 * TrendRail — pick a signal: table, reading(s), window.
 *
 * A dependent cascade, and the disabled state of each control is what says so.
 * There is no step numbering: the order is not a procedure someone has to
 * remember, it is a data dependency the controls already enforce.
 *
 * Three controls this once carried are deliberately gone. The timestamp column
 * is chosen for the reader — a table has one clock and picking it was a
 * question with one answer. The device filter went with it: on these tables the
 * device is already in the reading's own name (`CAM001-13-defect_1`), so
 * filtering by it again asked the reader to say the same thing twice.
 *
 * Everything is clamped rather than trusted, the same way the Live panel
 * editor's `applyBinding` does it. These selections arrive from a URL that may
 * be months old and point at a table that has since been dropped, so a stale
 * link has to degrade to "pick again" rather than to an error.
 *
 * Every read is pinned to one source: the datasource picked in the first
 * control, or — until one is picked — the first source selected in the header.
 * Choosing a datasource first and then one of *its* tables is the order the
 * data actually has; the table list below is that source's catalogue. Before
 * this picker, all reads were pinned to the *primary* selected source. The catalogue
 * routes resolve to it anyway, so letting the data call fan out instead would
 * offer a table only the first plant has and then draw one envelope per plant
 * on top of each other — three tolerance bands for one device.
 */

export default function TrendRail({ trend, range, onApplyWindow, onChange }) {
  const tr = useTranslation()
  const [draft, setDraft] = useState(() => ({ minutes: trend.minutes, start: dayjs(range.start), end: dayjs(range.end) }))
  useEffect(() => {
    setDraft({ minutes: trend.minutes, start: dayjs(range.start), end: dayjs(range.end) })
  }, [trend.minutes, range.start, range.end])
  const dateString = (date) => date?.isValid() ? date.second(0).format('YYYY-MM-DDTHH:mm:ssZ') : ''
  const rangeError = windowError(dateString(draft.start), dateString(draft.end))

  function pickWindow(minutes) {
    if (minutes === 'custom') {
      setDraft((d) => ({ ...d, minutes }))
    } else {
      onApplyWindow({ minutes, start: '', end: '' })
    }
  }
  const selected = useDatasourceSelectionStore((s) => s.selected)
  const primaryId = trendSourceId(trend, selected?.[0]?.id)

  // Any configured source can be browsed, not only the header's selection —
  // the trend reads one table from one source, so it has nothing to merge.
  const datasourcesQuery = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources, staleTime: 60_000 })
  const datasources = useMemo(() => datasourcesQuery.data ?? [], [datasourcesQuery.data])

  const tablesQuery = useQuery({
    queryKey: ['trend', 'tables', primaryId ?? 'app'],
    queryFn: () => fetchSchemaTables(primaryId ?? undefined),
    staleTime: 5 * 60_000,
  })

  const { query: columnsQuery, groups } = useTrendColumns(trend.table, primaryId)

  const tables = tablesQuery.data ?? []
  const cols = columnsQuery.data
  const arrayCols = useMemo(() => cols?.array_value_columns ?? [], [cols])
  const tsCols = useMemo(() => cols?.ts_columns ?? [], [cols])
  const valueCols = useMemo(() => trend.valueCols ?? [], [trend.valueCols])
  const hasGroups = groups.some((group) => group.key)
  // The group a *selection* belongs to is the group of its first reading. The
  // rest are held to that group by `pickGroup` below, so there is never a
  // second answer to disagree with.
  const activeGroup = groups.find((group) => group.options.some((option) => option.value === valueCols[0]))
  const readingOptions = hasGroups ? (activeGroup?.options ?? []) : (groups[0]?.options ?? [])
  // What the picker can currently render. A reading outside it would plot a
  // line with no entry in the list that is supposed to control it.
  const shownValueCols = useMemo(
    () => valueCols.filter((col) => readingOptions.some((option) => option.value === col)),
    [valueCols, readingOptions],
  )
  const labelFor = (value) => readingOptions.find((option) => option.value === value)?.label ?? value

  const set = useCallback((patch) => onChange({ ...trend, ...patch }), [onChange, trend])

  const clampedFor = useRef(null)

  // A binding whose table this source does not have is dropped outright, not
  // left to fail. The URL outlives the schema: a link shared last month, or the
  // header switched to another plant, and the table is simply gone. Holding the
  // dead name would show the same "table not allowed" twice — once here and
  // once on a chart that cannot draw — where clearing it asks the one useful
  // question instead.
  useEffect(() => {
    if (!tablesQuery.data || !trend.table) return
    if (!tables.some((t) => t.table === trend.table)) {
      clampedFor.current = null
      set({ table: '', valueCols: [], tsCol: '' })
    }
  }, [tablesQuery.data, tables, trend.table, set])

  // Clamp the binding to what the table can actually offer, once its columns
  // arrive. Guarded by a ref so it runs on each new *answer* rather than on
  // every render — `set` closes over `trend`, so an unguarded effect that
  // writes would re-run itself.
  useEffect(() => {
    if (!cols || !trend.table) return
    const stamp = `${primaryId ?? 'app'}::${trend.table}`
    if (clampedFor.current === stamp) return
    clampedFor.current = stamp

    // Each named reading is kept or dropped on its own — a link naming four
    // columns of which one has since been dropped is three quarters good, and
    // discarding the lot would be the harsher reading of the same URL.
    const kept = valueCols.filter((col) => arrayCols.includes(col))
    const nextCols = kept.length ? kept : (arrayCols[0] ? [arrayCols[0]] : [])
    const tsCol = tsCols.includes(trend.tsCol) ? trend.tsCol : (tsCols[0] ?? '')
    // Compared by content: `valueCols` is a fresh array on every parse of the
    // query string, so identity would report a change that never happened.
    if (nextCols.join(' ') !== valueCols.join(' ') || tsCol !== trend.tsCol) {
      set({ valueCols: nextCols, tsCol })
    }
  }, [cols, arrayCols, tsCols, valueCols, trend, primaryId, set])

  // A link naming a datasource that has since been deleted falls back to the
  // header's source rather than failing every read below.
  useEffect(() => {
    if (!datasourcesQuery.data || trend.datasourceId == null) return
    if (!datasources.some((d) => d.id === trend.datasourceId)) {
      clampedFor.current = null
      set({ datasourceId: null, table: '', valueCols: [], tsCol: '' })
    }
  }, [datasourcesQuery.data, datasources, trend.datasourceId, set])

  function pickSource(id) {
    // A different database: every table and column below describes the old one.
    clampedFor.current = null
    set({ datasourceId: id, table: '', valueCols: [], tsCol: '' })
  }

  function pickTable(table) {
    // Everything downstream describes the old table's columns.
    clampedFor.current = null
    set({ table, valueCols: [], tsCol: '' })
  }

  // Switching group replaces the selection rather than adding to it. A reading
  // held over from the previous group would be plotted by a chart whose picker
  // no longer lists it — on screen, but unreachable by the control that is
  // supposed to govern it.
  function pickGroup(key) {
    const first = groups.find((item) => item.key === key)?.options?.[0]?.value
    set({ valueCols: first ? [first] : [] })
  }

  // At least one reading, always: an empty selection is the chart asking to be
  // filled in, and unticking the last box is never that request — it is someone
  // swapping which single reading they are looking at.
  function pickReadings(next) {
    if (next.length) set({ valueCols: next })
  }

  const noArrays = !!cols && arrayCols.length === 0
  const catalogError = tablesQuery.error || columnsQuery.error

  return (
    <div className={`${styles.rail} report-trend-controls`}>
      <Field label={tr('Datasource')}>
        <Select
          value={datasources.some((d) => d.id === primaryId) ? primaryId : ''}
          displayEmpty
          inputProps={{ 'aria-label': tr('Datasource') }}
          onChange={(e) => pickSource(e.target.value)}
          renderValue={(id) => datasources.find((d) => d.id === id)?.name ?? tr('Choose a datasource')}
        >
          {datasources.map((d) => (
            <MenuItem key={d.id} value={d.id}>
              {d.name}
              <span className={styles.sourceDb}>{d.database}</span>
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Field label={tr('Table')}>
        <Select
          value={tables.some((t) => t.table === trend.table) ? trend.table : ''}
          displayEmpty
          disabled={primaryId == null}
          onChange={(e) => pickTable(e.target.value)}
          renderValue={(v) => v || tr('Choose a table')}
        >
          {tables.map((t) => (
            <MenuItem key={t.table} value={t.table}>{t.label}</MenuItem>
          ))}
        </Select>
      </Field>

      {hasGroups && (
        <Field label={tr('Group')}>
          <Select
            value={activeGroup?.key ?? ''}
            displayEmpty
            inputProps={{ 'aria-label': tr('Reading group') }}
            renderValue={() => activeGroup?.label ?? tr('Choose a group')}
            onChange={(e) => pickGroup(e.target.value)}
          >
            {groups.map((group) => (
              <MenuItem key={group.key} value={group.key}>{group.label}</MenuItem>
            ))}
          </Select>
        </Field>
      )}

      {/* Multiple by default, singular in effect until a second box is ticked:
          one reading is the ordinary case and still reads as one name, so the
          control does not announce a capability the reader has not asked for. */}
      <Field label={shownValueCols.length > 1 ? tr('Readings') : tr('Reading')} wide>
        <Select
          multiple
          value={shownValueCols}
          displayEmpty
          disabled={!trend.table || noArrays}
          inputProps={{ 'aria-label': tr('Reading') }}
          onChange={(e) => pickReadings(
            typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value,
          )}
          renderValue={(picked) =>
            !picked.length ? (noArrays ? tr('None available') : tr('Choose a column'))
              : picked.length <= 2 ? picked.map(labelFor).join(', ')
                // Past two names the control is wider than the answer is useful.
                // The chart's own legend below names every line in full.
                : tr('{count} readings', { count: picked.length })}
        >
          {readingOptions.map((option) => (
            <MenuItem key={option.value} value={option.value} className={styles.option}>
              <Checkbox size="small" checked={shownValueCols.includes(option.value)} />
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Field label={tr('Window')}>
        <Select
          value={draft.minutes}
          onChange={(e) => pickWindow(e.target.value)}
        >
          {TREND_RANGES.map((r) => (
            <MenuItem key={r.value} value={r.value}>{tr(r.label)}</MenuItem>
          ))}
          <MenuItem value="custom">{tr('Custom')}</MenuItem>
        </Select>
      </Field>

      {['start', 'end'].map((key) => (
        <DateTimePicker
          key={key}
          label={key === 'start' ? tr('Start') : tr('End')}
          value={draft[key]}
          onChange={(value) => setDraft((d) => ({ ...d, minutes: 'custom', [key]: value }))}
          format="DD/MM/YYYY HH:mm"
          ampm={false}
          slotProps={{ textField: { size: 'small', className: styles.picker } }}
        />
      ))}
      <Button size="small" variant="outlined" disabled={!!rangeError}
        onClick={() => onApplyWindow({ minutes: draft.minutes,
          start: dateString(draft.start), end: dateString(draft.end) })}>
        {tr('Apply')}
      </Button>
      {rangeError && <p className={styles.error} role="alert">{tr(rangeError)}</p>}

      {noArrays && (
        <p className={styles.hint}>
          {tr('{table} has no multi-value reading columns. This chart plots a column that stores a value with its setpoint and limits together.', { table: trend.table })}
        </p>
      )}
      {catalogError && (
        <p className={styles.error}>
          {apiErrorMessage(catalogError, catalogError.message)}
        </p>
      )}
    </div>
  )
}

function Field({ label, wide, children }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <FormControl size="small" className={wide ? styles.selectWide : styles.select}>
        {children}
      </FormControl>
    </div>
  )
}
