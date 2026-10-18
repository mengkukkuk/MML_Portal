import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import TextField from '@mui/material/TextField'
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
  table_name: '', ts_col: '', message_col: '', severity_col: '', match_col: '', match_filter: '',
}

const fromSource = (s) => (s?.configured ? {
  table_name: s.table_name ?? '',
  ts_col: s.ts_col ?? '',
  message_col: s.message_col ?? '',
  severity_col: s.severity_col ?? '',
  match_col: s.match_col ?? '',
  match_filter: s.match_filter ?? '',
} : EMPTY)

const blankToNull = (v) => (v.trim() ? v.trim() : null)

function statusLed(source) {
  if (!source?.configured) return styles.led
  if (source.available) return `${styles.led} ${styles.ledOk}`
  return `${styles.led} ${source.reason === 'missing' ? styles.ledWarn : styles.ledCrit}`
}

/**
 * Settings → Alert messages: where each connection keeps the alert text the
 * report trend marks along its time axis.
 *
 * Names are typed, not only picked. The table usually belongs to a line that
 * has not started writing it yet, so the form offers what the connection has
 * today as suggestions (a <datalist>) and accepts a name it does not have —
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
  const [dsId, setDsId] = useState('')
  useEffect(() => {
    if (dsId === '' && datasources.length) setDsId(datasources[0].id)
    if (dsId !== '' && datasources.length && !datasources.some((d) => d.id === dsId)) setDsId(datasources[0].id)
  }, [datasources, dsId])

  const sourceQuery = useQuery({
    queryKey: ['alert-source', dsId],
    queryFn: () => fetchAlertSource(dsId),
    enabled: dsId !== '',
  })
  const source = sourceQuery.data

  const [form, setForm] = useState(EMPTY)
  useEffect(() => setForm(fromSource(source)), [source])
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

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
    }
  }, [columns])

  const afterWrite = (data) => {
    queryClient.setQueryData(['alert-source', dsId], data)
    queryClient.invalidateQueries({ queryKey: ['alert-messages'] })
  }
  const save = useMutation({
    mutationFn: () => saveAlertSource(dsId, {
      table_name: form.table_name.trim(),
      ts_col: form.ts_col.trim(),
      message_col: form.message_col.trim(),
      severity_col: blankToNull(form.severity_col),
      match_col: form.match_filter ? blankToNull(form.match_col) : null,
      match_filter: form.match_filter || null,
    }),
    onSuccess: (data) => {
      afterWrite(data)
      notify(data.available ? 'Alert source saved.' : 'Alert source saved — waiting for its table.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to save alert source.'), 'error'),
  })
  const remove = useMutation({
    mutationFn: () => deleteAlertSource(dsId),
    onSuccess: () => {
      afterWrite({ datasource_id: dsId, configured: false })
      notify('Alert source removed.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to remove alert source.'), 'error'),
  })

  const required = form.table_name.trim() && form.ts_col.trim() && form.message_col.trim()
  const matchOk = !form.match_filter || form.match_col.trim()
  const dirty = JSON.stringify(form) !== JSON.stringify(fromSource(source))
  const busy = save.isPending || remove.isPending
  const readOnly = !isAdmin || busy

  const status = !source ? null
    : !source.configured ? tr('No alert source — the trend shows no message markers for this connection.')
      : source.available ? tr('Reading messages from {table}.', { table: source.table_name })
        : source.reason === 'missing'
          ? tr('Saved. {table} or one of its columns is not there yet — markers appear once it exists.', { table: source.table_name })
          : source.reason === 'unreachable' ? tr('Connection unreachable.') : tr('Cannot read the alert source.')

  const field = (key, label, list, hint) => (
    <TextField
      size="small"
      label={tr(label)}
      value={form[key]}
      onChange={set(key)}
      disabled={readOnly}
      helperText={hint ? tr(hint) : undefined}
      slotProps={{ htmlInput: { list: list?.length ? `alert-${key}` : undefined, spellCheck: false } }}
    />
  )

  if (!datasources.length) {
    return <p className={styles.dsEmpty}>{tr('Add a connection first.')}</p>
  }

  return (
    <>
      <p className={styles.fldHint}>{tr('The report trend marks the moments a plant wrote an alert. Name the table and columns that hold them, per connection. The table may be created later — save it now and markers appear once it exists.')}</p>
      {!isAdmin && (
        <p className={styles.dsReadonly}>
          <span className={styles.led} /> {tr('Only administrators can change this.')}</p>
      )}

      <div className={styles.acqRow}>
        <div className={styles.acqLabel}>
          <p className={styles.fldLabel}>{tr('Connection')}</p>
        </div>
        <div className={styles.acqCtl}>
          <FormControl size="small" sx={{ minWidth: 260 }}>
            <Select value={dsId} onChange={(e) => setDsId(e.target.value)} disabled={busy}>
              {datasources.map((ds) => <MenuItem key={ds.id} value={ds.id}>{ds.name}</MenuItem>)}
            </Select>
          </FormControl>
        </div>
      </div>

      {status && (
        <p className={styles.alertStatus} role="status">
          <span className={statusLed(source)} /> {status}
          {source?.configured && !source.available && source.detail && (
            <span className={styles.alertDetail}>{source.detail}</span>
          )}
        </p>
      )}

      <div className={styles.alertGrid}>
        {field('table_name', 'Table', tables.map((t) => t.table))}
        {field('ts_col', 'Time column', suggest.time)}
        {field('message_col', 'Message column', suggest.message)}
        {field('severity_col', 'Severity column (optional)', suggest.severity,
          'crit / critical / alarm / high / 2 → critical · warn / warning / medium / 1 → warning · else info')}
        <FormControl size="small">
          <InputLabel id="alert-match-filter">{tr('Follows report filter')}</InputLabel>
          <Select
            labelId="alert-match-filter"
            label={tr('Follows report filter')}
            value={form.match_filter}
            onChange={set('match_filter')}
            disabled={readOnly}
          >
            <MenuItem value="">{tr('None — every message')}</MenuItem>
            <MenuItem value="location">{tr('Location')}</MenuItem>
            <MenuItem value="camera">{tr('Camera')}</MenuItem>
          </Select>
        </FormControl>
        {form.match_filter && field('match_col', 'Match column', suggest.match,
          form.match_filter === 'location'
            ? 'Holds the same values as the report Location filter'
            : 'Holds the same values as the report Camera filter')}
      </div>

      {/* One datalist per field; the inputs above point at them by id. */}
      {[['table_name', tables.map((t) => t.table)], ['ts_col', suggest.time],
        ['message_col', suggest.message], ['severity_col', suggest.severity],
        ['match_col', suggest.match]].map(([key, list]) => (
        <datalist key={key} id={`alert-${key}`}>
          {list.map((v) => <option key={v} value={v} />)}
        </datalist>
      ))}

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
