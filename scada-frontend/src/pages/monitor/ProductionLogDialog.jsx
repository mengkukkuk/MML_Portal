import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import {
  fetchSchemaColumns, fetchSchemaLatest, fetchSchemaTables, fetchSchemaValues,
  fromPrimarySource,
} from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import styles from './ProductionLogDialog.module.css'

/**
 * Two plant layouts put a good and a reject counter in one table, and they are
 * not variations of each other — they need different questions asked.
 *
 * - `wide`: one row per sample carrying both counters in two columns, narrowed
 *   by at most one shared filter. What this dialog has always assumed.
 * - `tag`: both counters in the *same* value column, told apart by a tag
 *   column — the tag-per-row shape a historian keyed by tag name produces (a
 *   `counter_tag` table holding Counter1/Counter2/Counter3 as rows). No shared
 *   filter can express it: the two counters need different *values* of one
 *   column, and a single filter value would narrow both series to one tag and
 *   leave the other empty — silently, with a plausible-looking chart.
 */
const LAYOUTS = [
  {
    value: 'wide',
    label: 'Two columns / สองคอลัมน์',
    hint: 'One row per sample carrying both counters side by side, e.g. good_count and reject_count.',
  },
  {
    value: 'tag',
    label: 'One column, two tags / คอลัมน์เดียว สองแท็ก',
    hint: 'Both counters in one value column, told apart by a tag column — e.g. value_tag, with tag_name naming Counter1 or Counter2.',
  },
]

const blank = {
  layout: 'wide',
  datasourceId: '', table: '', tsCol: '', producedCol: '', rejectedCol: '',
  filterCol: '', filterVal: '', producedTag: '', rejectedTag: '',
}

function fromBinding(binding) {
  if (!binding) return blank
  // The stored document has no layout field: which one it is *is* whether the
  // per-counter tags are there. Keeping it derived means an older binding
  // opens as exactly what it has always been.
  const tagged = binding.produced_filter_val != null && binding.rejected_filter_val != null
  return {
    layout: tagged ? 'tag' : 'wide',
    datasourceId: binding.datasource_id ?? '',
    table: binding.table ?? '',
    tsCol: binding.ts_col ?? '',
    producedCol: binding.produced_col ?? '',
    rejectedCol: binding.rejected_col ?? '',
    filterCol: binding.filter_col ?? '',
    filterVal: binding.filter_val ?? '',
    producedTag: binding.produced_filter_val ?? '',
    rejectedTag: binding.rejected_filter_val ?? '',
  }
}

export default function ProductionLogDialog({ open, binding, container, onClose, onSave }) {
  const [form, setForm] = useState(() => fromBinding(binding))
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))
  const tagged = form.layout === 'tag'

  useEffect(() => { if (open) setForm(fromBinding(binding)) }, [binding, open])

  const datasourceId = form.datasourceId === '' ? undefined : Number(form.datasourceId)
  const selectionKey = useDatasourceSelectionStore((state) => state.selectionKey)
  const selectedDatasources = useDatasourceSelectionStore((state) => state.selected)
  const primaryDatasource = selectedDatasources[0]
  const sourceKey = datasourceId ?? `header:${selectionKey}`
  const tablesQuery = useQuery({
    queryKey: ['schema-tables', sourceKey], queryFn: () => fetchSchemaTables(datasourceId), enabled: open,
  })
  const columnsQuery = useQuery({
    queryKey: ['schema-columns', sourceKey, form.table],
    queryFn: () => fetchSchemaColumns(form.table, datasourceId),
    enabled: open && !!form.table,
  })
  const valuesQuery = useQuery({
    queryKey: ['schema-values', sourceKey, form.table, form.filterCol],
    queryFn: () => fetchSchemaValues(form.table, form.filterCol, 500, datasourceId),
    enabled: open && !!form.table && !!form.filterCol,
  })

  const columns = columnsQuery.data
  const timestampColumns = columns?.datetime_columns ?? columns?.ts_columns ?? []
  useEffect(() => {
    if (!columns) return
    setForm((current) => {
      const next = { ...current }
      if (!columns.value_columns.includes(next.producedCol)) next.producedCol = columns.value_columns[0] ?? ''
      if (next.layout === 'tag') {
        // One column, both counters. Holding two selects in step here would
        // only invite an admin to set them differently and get two unrelated
        // series back.
        next.rejectedCol = next.producedCol
      } else if (!columns.value_columns.includes(next.rejectedCol) || next.rejectedCol === next.producedCol) {
        next.rejectedCol = columns.value_columns.find((column) => column !== next.producedCol) ?? ''
      }
      const compatibleTimestamps = columns.datetime_columns ?? columns.ts_columns
      if (!compatibleTimestamps.includes(next.tsCol)) next.tsCol = compatibleTimestamps[0] ?? ''
      if (next.filterCol && !columns.filter_columns.includes(next.filterCol)) {
        next.filterCol = ''
        next.filterVal = ''
        next.producedTag = ''
        next.rejectedTag = ''
      }
      return next
    })
  }, [columns, form.layout])

  const sameTag = tagged && !!form.producedTag && form.producedTag === form.rejectedTag
  const valid = !!form.table && !!form.tsCol && !!form.producedCol && !!form.rejectedCol
    && (tagged
      ? !!form.filterCol && !!form.producedTag && !!form.rejectedTag && !sameTag
      : form.producedCol !== form.rejectedCol && (!form.filterCol || form.filterVal !== ''))

  const previewQuery = useQuery({
    queryKey: ['production-log-preview', sourceKey, form],
    queryFn: async () => {
      const common = { table: form.table, tsCol: form.tsCol, datasourceId }
      // In tag mode the filter is what tells the counters apart, so each side
      // previews under its own tag. Previewing both under one would show the
      // same figure twice and hide the mistake this dialog exists to prevent.
      const [produced, rejected] = await Promise.all([
        fetchSchemaLatest({
          ...common,
          valueCol: form.producedCol,
          filterCol: form.filterCol || undefined,
          filterVal: tagged ? form.producedTag : (form.filterCol ? form.filterVal : undefined),
        }),
        fetchSchemaLatest({
          ...common,
          valueCol: form.rejectedCol,
          filterCol: form.filterCol || undefined,
          filterVal: tagged ? form.rejectedTag : (form.filterCol ? form.filterVal : undefined),
        }),
      ])
      return {
        produced: fromPrimarySource(produced.readings, produced.sources),
        rejected: fromPrimarySource(rejected.readings, rejected.sources),
      }
    },
    enabled: open && valid,
    retry: false,
  })

  const tableOptions = tablesQuery.data ?? []
  const filterValues = useMemo(() => valuesQuery.data ?? [], [valuesQuery.data])
  const layoutHint = LAYOUTS.find((entry) => entry.value === form.layout)?.hint

  function submit() {
    onSave({
      datasource_id: datasourceId ?? null,
      table: form.table,
      ts_col: form.tsCol,
      produced_col: form.producedCol,
      rejected_col: tagged ? form.producedCol : form.rejectedCol,
      filter_col: form.filterCol || null,
      // The shared filter and the per-counter tags are mutually exclusive — the
      // server rejects a binding carrying both, because one would narrow each
      // series a second time.
      filter_val: tagged ? null : (form.filterCol ? form.filterVal : null),
      produced_filter_val: tagged ? form.producedTag : null,
      rejected_filter_val: tagged ? form.rejectedTag : null,
    })
  }

  return (
    <Dialog open={open} onClose={onClose} container={container} fullWidth maxWidth="md">
      <DialogTitle>Production Log / ตั้งค่าบันทึกผลผลิต</DialogTitle>
      <DialogContent dividers className={styles.content}>
        <p className={styles.intro}>
          Choose two cumulative counters from the same timestamped table.
          Hourly production is calculated from positive counter increments between 08:00 and 18:00.
        </p>

        <div className={styles.grid}>
          <label className={styles.full}>
            <span>Counter layout / รูปแบบตัวนับ</span>
            <select
              value={form.layout}
              onChange={(event) => set({
                layout: event.target.value,
                filterVal: '',
                producedTag: '',
                rejectedTag: '',
              })}
            >
              {LAYOUTS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>
          {layoutHint && <p className={`${styles.intro} ${styles.full}`}>{layoutHint}</p>}

          <label>
            <span>Datasource / แหล่งข้อมูล</span>
            <select value={form.datasourceId} onChange={(event) => set({ datasourceId: event.target.value, table: '' })}>
              <option value="">Follow header selection</option>
              {binding?.datasource_id != null
                && binding.datasource_id !== primaryDatasource?.id && (
                <option value={binding.datasource_id} disabled>
                  Previously configured source (not selected)
                </option>
              )}
              {primaryDatasource && (
                <option value={primaryDatasource.id}>Current primary — {primaryDatasource.name}</option>
              )}
            </select>
          </label>

          <label>
            <span>Table / ตาราง</span>
            <select value={form.table} onChange={(event) => set({ table: event.target.value })}>
              <option value="">Select table…</option>
              {tableOptions.map((table) => <option key={table.table} value={table.table}>{table.label ?? table.table}</option>)}
            </select>
          </label>

          <label>
            <span>Timestamp / เวลา</span>
            <select value={form.tsCol} onChange={(event) => set({ tsCol: event.target.value })} disabled={!columns}>
              <option value="">Select timestamp…</option>
              {timestampColumns.map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          <label>
            <span>{tagged ? 'Counter column / คอลัมน์ค่าตัวนับ' : 'Good counter / ตัวนับผลิตดี'}</span>
            <select value={form.producedCol} onChange={(event) => set({ producedCol: event.target.value })} disabled={!columns}>
              <option value="">Select counter…</option>
              {(columns?.value_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          {!tagged && (
            <label>
              <span>Reject counter / ตัวนับของเสีย</span>
              <select value={form.rejectedCol} onChange={(event) => set({ rejectedCol: event.target.value })} disabled={!columns}>
                <option value="">Select counter…</option>
                {(columns?.value_columns ?? []).map((column) => <option key={column}>{column}</option>)}
              </select>
            </label>
          )}

          <label>
            <span>{tagged ? 'Tag column / คอลัมน์ชื่อแท็ก' : 'Filter column / คอลัมน์กรอง'}</span>
            <select
              value={form.filterCol}
              onChange={(event) => set({ filterCol: event.target.value, filterVal: '', producedTag: '', rejectedTag: '' })}
              disabled={!columns}
            >
              <option value="">{tagged ? 'Select tag column…' : 'No filter'}</option>
              {(columns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          {tagged ? (
            <>
              <label>
                <span>Good tag / แท็กผลิตดี</span>
                <input
                  list="production-log-filter-values"
                  value={form.producedTag}
                  onChange={(event) => set({ producedTag: event.target.value })}
                  disabled={!form.filterCol}
                />
              </label>
              <label>
                <span>Reject tag / แท็กของเสีย</span>
                <input
                  list="production-log-filter-values"
                  value={form.rejectedTag}
                  onChange={(event) => set({ rejectedTag: event.target.value })}
                  disabled={!form.filterCol}
                />
              </label>
            </>
          ) : form.filterCol && (
            <label className={styles.full}>
              <span>Filter value / ค่าที่กรอง</span>
              <input value={form.filterVal} onChange={(event) => set({ filterVal: event.target.value })} list="production-log-filter-values" />
            </label>
          )}

          <datalist id="production-log-filter-values">
            {filterValues.map((value) => <option key={value} value={value} />)}
          </datalist>
        </div>

        {sameTag && (
          <Alert severity="warning">
            The same tag cannot be both counters — pick a different tag for one of them.
          </Alert>
        )}

        {valid && previewQuery.isPending && <p className={styles.preview}>Checking the latest counters…</p>}
        {previewQuery.isError && <Alert severity="warning">The selected counter stream could not be read.</Alert>}
        {previewQuery.data && (
          <div className={styles.preview}>
            <span>Latest good <b>{previewQuery.data.produced?.value ?? '—'}</b></span>
            <span>Latest reject <b>{previewQuery.data.rejected?.value ?? '—'}</b></span>
          </div>
        )}
      </DialogContent>
      <DialogActions>
        {binding && <Button color="error" onClick={() => onSave(null)}>Remove configuration</Button>}
        <span className={styles.spacer} />
        <Button color="inherit" onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={submit}>Use counters</Button>
      </DialogActions>
    </Dialog>
  )
}
