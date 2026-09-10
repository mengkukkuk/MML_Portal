import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import Button from '@mui/material/Button'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { windowError } from './trendWindow'
import { useQuery } from '@tanstack/react-query'
import FormControl from '@mui/material/FormControl'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import { fetchSchemaTables, fetchSchemaValues } from '@/api/schema'
import { useTrendColumns } from './useTrendColumns'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { TIME_RANGES } from '@/components/live/usePanelSeries'
import styles from './TrendRail.module.css'

/**
 * TrendRail — pick a signal: table, reading, clock, device, window.
 *
 * A dependent cascade, and the disabled state of each control is what says so.
 * There is no step numbering: the order is not a procedure someone has to
 * remember, it is a data dependency the controls already enforce.
 *
 * Everything is clamped rather than trusted, the same way the Live panel
 * editor's `applyBinding` does it. These selections arrive from a URL that may
 * be months old and point at a table that has since been dropped, so a stale
 * link has to degrade to "pick again" rather than to an error.
 *
 * All five reads are pinned to the *primary* selected source. The catalogue
 * routes resolve to it anyway, so letting the data call fan out instead would
 * offer a table only the first plant has and then draw one envelope per plant
 * on top of each other — three tolerance bands for one device.
 */

export default function TrendRail({ trend, range, onApplyWindow, onChange }) {
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
  const primaryId = selected?.[0]?.id

  const tablesQuery = useQuery({
    queryKey: ['trend', 'tables', primaryId ?? 'app'],
    queryFn: () => fetchSchemaTables(primaryId ?? undefined),
    staleTime: 5 * 60_000,
  })

  const { query: columnsQuery, groups } = useTrendColumns(trend.table, primaryId)

  const valuesQuery = useQuery({
    queryKey: ['trend', 'values', primaryId ?? 'app', trend.table, trend.filterCol],
    queryFn: () => fetchSchemaValues(trend.table, trend.filterCol, 500, primaryId ?? undefined),
    enabled: !!(trend.table && trend.filterCol),
    staleTime: 60_000,
  })

  const tables = tablesQuery.data ?? []
  const cols = columnsQuery.data
  const arrayCols = useMemo(() => cols?.array_value_columns ?? [], [cols])
  const tsCols = useMemo(() => cols?.ts_columns ?? [], [cols])
  const filterCols = useMemo(() => cols?.filter_columns ?? [], [cols])
  const deviceValues = valuesQuery.data ?? []
  const hasGroups = groups.some((group) => group.key)
  const activeGroup = groups.find((group) => group.options.some((option) => option.value === trend.valueCol))
  const readingOptions = hasGroups ? (activeGroup?.options ?? []) : (groups[0]?.options ?? [])

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
      set({ table: '', valueCol: '', tsCol: '', filterCol: '', filterVal: '' })
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

    const valueCol = arrayCols.includes(trend.valueCol) ? trend.valueCol : (arrayCols[0] ?? '')
    const tsCol = tsCols.includes(trend.tsCol) ? trend.tsCol : (tsCols[0] ?? '')
    const filterCol = filterCols.includes(trend.filterCol) ? trend.filterCol : ''
    // A device value that no longer belongs to a column can't be validated
    // until that column's own values load, so it is dropped with the column.
    const filterVal = filterCol ? trend.filterVal : ''
    if (
      valueCol !== trend.valueCol || tsCol !== trend.tsCol ||
      filterCol !== trend.filterCol || filterVal !== trend.filterVal
    ) {
      set({ valueCol, tsCol, filterCol, filterVal })
    }
  }, [cols, arrayCols, tsCols, filterCols, trend, primaryId, set])

  // Same for the device: a link naming a machine this column has never reported
  // would otherwise hold the chart empty with no hint why.
  useEffect(() => {
    if (!valuesQuery.data || !trend.filterVal) return
    if (!deviceValues.includes(trend.filterVal)) set({ filterVal: '' })
  }, [valuesQuery.data, deviceValues, trend.filterVal, set])

  function pickTable(table) {
    // Everything downstream describes the old table's columns.
    clampedFor.current = null
    set({ table, valueCol: '', tsCol: '', filterCol: '', filterVal: '' })
  }

  const noArrays = !!cols && arrayCols.length === 0
  const catalogError = tablesQuery.error || columnsQuery.error

  return (
    <div className={`${styles.rail} report-trend-controls`}>
      <Field label="Table">
        <Select
          value={tables.some((t) => t.table === trend.table) ? trend.table : ''}
          displayEmpty
          onChange={(e) => pickTable(e.target.value)}
          renderValue={(v) => v || 'Choose a table'}
        >
          {tables.map((t) => (
            <MenuItem key={t.table} value={t.table}>{t.label}</MenuItem>
          ))}
        </Select>
      </Field>

      {hasGroups && (
        <Field label="Group">
          <Select
            value={activeGroup?.key ?? ''}
            displayEmpty
            inputProps={{ 'aria-label': 'Reading group' }}
            renderValue={() => activeGroup?.label ?? 'Choose a group'}
            onChange={(e) => {
              const group = groups.find((item) => item.key === e.target.value)
              set({ valueCol: group.options[0].value })
            }}
          >
            {groups.map((group) => (
              <MenuItem key={group.key} value={group.key}>{group.label}</MenuItem>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Reading" wide>
        <Select
          value={arrayCols.includes(trend.valueCol) ? trend.valueCol : ''}
          displayEmpty
          disabled={!trend.table || noArrays}
          inputProps={{ 'aria-label': 'Reading' }}
          onChange={(e) => set({ valueCol: e.target.value })}
          renderValue={(v) => readingOptions.find((option) => option.value === v)?.label || (noArrays ? 'None available' : 'Choose a column')}
        >
          {readingOptions.map((option) => (
            <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
          ))}
        </Select>
      </Field>

      <Field label="Time">
        <Select
          value={tsCols.includes(trend.tsCol) ? trend.tsCol : ''}
          displayEmpty
          disabled={!trend.table || !tsCols.length}
          onChange={(e) => set({ tsCol: e.target.value })}
          renderValue={(v) => v || 'Choose a column'}
        >
          {tsCols.map((c) => (
            <MenuItem key={c} value={c}>{c}</MenuItem>
          ))}
        </Select>
      </Field>

      <Field label="Device">
        <Select
          value={filterCols.includes(trend.filterCol) ? trend.filterCol : ''}
          displayEmpty
          disabled={!trend.table}
          onChange={(e) => set({ filterCol: e.target.value, filterVal: '' })}
          renderValue={(v) => v || 'Whole table'}
        >
          <MenuItem value="">Whole table</MenuItem>
          {filterCols.map((c) => (
            <MenuItem key={c} value={c}>{c}</MenuItem>
          ))}
        </Select>
      </Field>

      {!!trend.filterCol && (
        <Field label="Is">
          <Select
            value={deviceValues.includes(trend.filterVal) ? trend.filterVal : ''}
            displayEmpty
            disabled={valuesQuery.isLoading}
            onChange={(e) => set({ filterVal: e.target.value })}
            renderValue={(v) => v || (valuesQuery.isLoading ? 'Loading…' : 'Any')}
          >
            <MenuItem value="">Any</MenuItem>
            {deviceValues.map((v) => (
              <MenuItem key={v} value={v}>{v}</MenuItem>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Window">
        <Select
          value={draft.minutes}
          onChange={(e) => pickWindow(e.target.value)}
        >
          {TIME_RANGES.map((r) => (
            <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>
          ))}
          <MenuItem value="custom">Custom</MenuItem>
        </Select>
      </Field>

      {['start', 'end'].map((key) => (
        <DateTimePicker
          key={key}
          label={key === 'start' ? 'Start' : 'End'}
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
        Apply
      </Button>
      {rangeError && <p className={styles.error} role="alert">{rangeError}</p>}

      {noArrays && (
        <p className={styles.hint}>
          {trend.table} has no multi-value reading columns. This chart plots a
          column that stores a value with its setpoint and limits together.
        </p>
      )}
      {catalogError && (
        <p className={styles.error}>
          {catalogError?.response?.data?.detail || catalogError.message}
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
