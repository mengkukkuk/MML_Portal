import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import TextField from '@mui/material/TextField'
import Autocomplete from '@mui/material/Autocomplete'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Button from '@mui/material/Button'
import { useTranslation } from '@/i18n'
import { deleteAlertSource, fetchAlertSource, saveAlertSource } from '@/api/alerts'
import { fetchSchemaColumns, fetchSchemaTables } from '@/api/schema'
import { apiErrorMessage } from '@/api/client'
import styles from './SettingsPage.module.css'

const EMPTY = {
  datasource_id: '', table_name: '', ts_col: '', message_col: '', severity_col: '', match_col: '', match_filter: '',
  role_col: '',
}

const fromSource = (s) => (s?.configured ? {
  datasource_id: s.datasource_id ?? '',
  table_name: s.table_name ?? '',
  ts_col: s.ts_col ?? '',
  message_col: s.message_col ?? '',
  severity_col: s.severity_col ?? '',
  match_col: s.match_col ?? '',
  match_filter: s.match_filter ?? '',
  role_col: s.role_col ?? '',
} : EMPTY)

const blankToNull = (v) => (v.trim() ? v.trim() : null)

// Every name read from the source table. They describe one table on one
// connection, so a new connection or a new table leaves them meaningless.
const COLUMN_KEYS = ['ts_col', 'message_col', 'severity_col', 'match_col', 'role_col']
const clearColumns = Object.fromEntries(COLUMN_KEYS.map((k) => [k, '']))

// A field holding a name already in the list is a field being re-chosen, not
// narrowed: show the whole list, with the current pick in it. Anything else is
// typed text, and filters — a browser <datalist> filtered in both cases, so
// once a table was picked the list only ever offered that same table.
function suggestionsFor(options, { inputValue }) {
  const typed = inputValue.trim().toLowerCase()
  if (!typed || options.some((o) => o.toLowerCase() === typed)) return options
  return options.filter((o) => o.toLowerCase().includes(typed))
}

function statusLed(source) {
  if (!source?.configured) return styles.led
  if (source.available) return `${styles.led} ${styles.ledOk}`
  return `${styles.led} ${source.reason === 'missing' ? styles.ledWarn : styles.ledCrit}`
}

/**
 * Settings → Alert messages: the one place the alert text the report trend
 * marks along its time axis is read from.
 *
 * One source for every trend, including the connection it lives on, which is
 * usually not the connection the readings come from (alerts in the vision
 * database, sensor_log1 in MMLData). The connection is part of what is saved,
 * so the form always opens on the saved source.
 *
 * Names are typed, not only picked. The table usually belongs to a line that
 * has not started writing it yet, so the form offers what the connection has
 * today as suggestions (a free-text Autocomplete) and accepts a name it does not have —
 * the server saves it either way and says, in the status line, whether it can
 * be read now. That status is the point of the form: "saved, waiting for the
 * table" and "saved and reading" have to look different.
 *
 * Severity needs no mapping: the column's words are read by convention on the
 * server (crit/critical/alarm/high/2, warn/warning/medium/1, anything else is
 * information), which the hint under the field says.
 */
export default function AlertSourceSettings({ datasources, isAdmin, notify }) {
  const tr = useTranslation()
  const queryClient = useQueryClient()
  const sourceQuery = useQuery({ queryKey: ['alert-source'], queryFn: fetchAlertSource })
  const source = sourceQuery.data

  const [form, setForm] = useState(EMPTY)
  useEffect(() => setForm(fromSource(source)), [source])
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setText = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  // A different connection has different tables: its table and every column
  // start blank rather than carrying names it may not have.
  const pickConnection = (e) => setForm((f) => (e.target.value === f.datasource_id ? f
    : { ...f, datasource_id: e.target.value, table_name: '', ...clearColumns }))
  // Choosing another table from the list does the same for the columns. Typing
  // does not: half a table name is not a decision to throw the columns away.
  const pickTable = (value) => setForm((f) => (value === f.table_name ? f
    : { ...f, table_name: value, ...clearColumns }))
  const dsId = form.datasource_id

  // Suggestions only — admins see the connection's catalogue, and a name that
  // is not in it is still accepted.
  const { data: tables = [] } = useQuery({
    queryKey: ['schema-tables', dsId],
    queryFn: () => fetchSchemaTables(dsId),
    enabled: isAdmin && dsId !== '',
    staleTime: 60_000,
  })
  const tableExists = tables.some((t) => t.table === form.table_name.trim())
  const { data: columns } = useQuery({
    queryKey: ['schema-columns', dsId, form.table_name.trim()],
    queryFn: () => fetchSchemaColumns(form.table_name.trim(), dsId),
    enabled: isAdmin && tableExists,
    staleTime: 60_000,
  })
  const suggest = useMemo(() => {
    const c = columns ?? {}
    const uniq = (...lists) => [...new Set(lists.flat().filter(Boolean))]
    return {
      time: uniq(c.ts_columns ?? [], c.datetime_columns ?? []),
      message: uniq(c.text_columns ?? []),
      severity: uniq(c.text_columns ?? [], c.value_columns ?? []),
      match: uniq(c.filter_columns ?? [], c.text_columns ?? []),
      role: uniq(c.filter_columns ?? [], c.value_columns ?? [], c.text_columns ?? []),
    }
  }, [columns])

  const afterWrite = (data) => {
    queryClient.setQueryData(['alert-source'], data)
    queryClient.invalidateQueries({ queryKey: ['alert-messages'] })
  }
  const save = useMutation({
    mutationFn: () => saveAlertSource({
      datasource_id: dsId,
      table_name: form.table_name.trim(),
      ts_col: form.ts_col.trim(),
      message_col: form.message_col.trim(),
      severity_col: blankToNull(form.severity_col),
      match_col: form.match_filter ? blankToNull(form.match_col) : null,
      match_filter: form.match_filter || null,
      role_col: blankToNull(form.role_col),
    }),
    onSuccess: (data) => {
      afterWrite(data)
      notify(data.available ? 'Alert source saved.' : 'Alert source saved — waiting for its table.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to save alert source.'), 'error'),
  })
  const remove = useMutation({
    mutationFn: () => deleteAlertSource(),
    onSuccess: () => {
      afterWrite({ configured: false })
      notify('Alert source removed.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to remove alert source.'), 'error'),
  })

  const required = dsId !== '' && form.table_name.trim() && form.ts_col.trim() && form.message_col.trim()
  const matchOk = !form.match_filter || form.match_col.trim()
  const dirty = JSON.stringify(form) !== JSON.stringify(fromSource(source))
  const busy = save.isPending || remove.isPending
  const readOnly = !isAdmin || busy

  const status = !source ? null
    : !source.configured ? tr('No alert source — the trend shows no message markers.')
      : source.available
        ? tr('Reading messages from {table} on {connection}.', { table: source.table_name, connection: source.datasource_name })
        : source.reason === 'missing'
          ? tr('Saved. {table} or one of its columns is not there yet — markers appear once it exists.', { table: source.table_name })
          : source.reason === 'unreachable' ? tr('Connection unreachable.') : tr('Cannot read the alert source.')

  // Free text with suggestions: the connection's names today are offered, a
  // name it does not have yet is still accepted (see the note above).
  const field = (key, label, list, hint, onPick, disabled = false) => (
    <Autocomplete
      freeSolo
      size="small"
      options={list}
      filterOptions={suggestionsFor}
      value={form[key]}
      inputValue={form[key]}
      onInputChange={(_e, value, reason) => {
        if ((reason === 'selectOption' || reason === 'clear') && onPick) onPick(value)
        else if (reason !== 'reset') setText(key, value)
      }}
      onChange={(_e, value) => (onPick ?? ((v) => setText(key, v)))(value ?? '')}
      disabled={readOnly || disabled}
      renderInput={(params) => (
        <TextField
          {...params}
          label={tr(label)}
          helperText={hint ? tr(hint) : undefined}
          slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false } }}
        />
      )}
    />
  )

  if (!datasources.length) {
    return <p className={styles.dsEmpty}>{tr('Add a connection first.')}</p>
  }

  // Three groups on one 3-column grid, so every box lines up with the boxes
  // above and below it: where the alerts are (Source), what each row says
  // (Columns), and whom a row is for (Routing). The match column keeps its slot
  // while no filter is followed — disabled, not removed — so picking a filter
  // does not reflow the row under the reader's pointer.
  return (
    <>
      <p className={styles.fldHint}>{tr('The report trend marks each alert a plant writes. One source serves every trend; the table may be created later — markers appear once it exists.')}</p>
      {!isAdmin && (
        <p className={styles.dsReadonly}>
          <span className={styles.led} /> {tr('Only administrators can change this.')}</p>
      )}

      <div className={styles.alertGroup}>
        <p className={styles.alertGroupLabel}>{tr('Source')}</p>
        <div className={styles.alertGrid}>
          <FormControl size="small">
            <InputLabel id="alert-connection">{tr('Connection')}</InputLabel>
            <Select
              labelId="alert-connection"
              label={tr('Connection')}
              value={dsId}
              onChange={pickConnection}
              disabled={readOnly}
            >
              {datasources.map((ds) => <MenuItem key={ds.id} value={ds.id}>{ds.name}</MenuItem>)}
            </Select>
          </FormControl>
          {field('table_name', 'Table', tables.map((t) => t.table), undefined, pickTable)}
          {status && (
            <p className={styles.alertStatus} role="status">
              <span className={statusLed(source)} />
              <span className={styles.alertStatusText}>{status}</span>
              {source?.configured && !source.available && source.detail && (
                <span className={styles.alertDetail}>{source.detail}</span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className={styles.alertGroup}>
        <p className={styles.alertGroupLabel}>{tr('Columns')}</p>
        <div className={styles.alertGrid}>
          {field('ts_col', 'Time column', suggest.time)}
          {field('message_col', 'Message column', suggest.message)}
          {field('severity_col', 'Severity column (optional)', suggest.severity,
            'crit / critical / alarm / high / 2 → critical · warn / warning / medium / 1 → warning · else info')}
        </div>
      </div>

      <div className={styles.alertGroup}>
        <p className={styles.alertGroupLabel}>{tr('Routing')}</p>
        <div className={styles.alertGrid}>
          <FormControl size="small">
            <InputLabel id="alert-match-filter" shrink>{tr('Follows report filter')}</InputLabel>
            <Select
              labelId="alert-match-filter"
              label={tr('Follows report filter')}
              notched
              displayEmpty
              value={form.match_filter}
              onChange={set('match_filter')}
              disabled={readOnly}
            >
              <MenuItem value="">{tr('None — every message')}</MenuItem>
              <MenuItem value="location">{tr('Location')}</MenuItem>
              <MenuItem value="camera">{tr('Camera')}</MenuItem>
            </Select>
          </FormControl>
          {field('match_col', 'Match column', suggest.match,
            !form.match_filter ? 'Choose a report filter to follow first'
              : form.match_filter === 'location'
                ? 'Holds the same values as the report Location filter'
                : 'Holds the same values as the report Camera filter',
            undefined, !form.match_filter)}
          {field('role_col', 'Role ID column (optional)', suggest.role,
            'Holds a Role ID from Response roles — a tagged row skips the rules')}
        </div>
      </div>

      {isAdmin && (
        <div className={styles.alertActions}>
          {source?.configured && (
            <Button color="error" size="small" onClick={() => remove.mutate()} disabled={busy}>
              {tr('Remove')}
            </Button>
          )}
          <Button
            variant="contained"
            size="small"
            onClick={() => save.mutate()}
            disabled={busy || !required || !matchOk || (!dirty && source?.configured)}
            loading={save.isPending}
          >
            {tr('Save alert source')}
          </Button>
        </div>
      )}
    </>
  )
}
