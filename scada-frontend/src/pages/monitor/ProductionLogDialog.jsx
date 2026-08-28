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


const blank = {
  datasourceId: '', table: '', tsCol: '', producedCol: '', rejectedCol: '',
  filterCol: '', filterVal: '',
}

function fromBinding(binding) {
  if (!binding) return blank
  return {
    datasourceId: binding.datasource_id ?? '',
    table: binding.table ?? '',
    tsCol: binding.ts_col ?? '',
    producedCol: binding.produced_col ?? '',
    rejectedCol: binding.rejected_col ?? '',
    filterCol: binding.filter_col ?? '',
    filterVal: binding.filter_val ?? '',
  }
}

export default function ProductionLogDialog({ open, binding, container, onClose, onSave }) {
  const [form, setForm] = useState(() => fromBinding(binding))
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

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
      if (!columns.value_columns.includes(next.rejectedCol) || next.rejectedCol === next.producedCol) {
        next.rejectedCol = columns.value_columns.find((column) => column !== next.producedCol) ?? ''
      }
      const compatibleTimestamps = columns.datetime_columns ?? columns.ts_columns
      if (!compatibleTimestamps.includes(next.tsCol)) next.tsCol = compatibleTimestamps[0] ?? ''
      if (next.filterCol && !columns.filter_columns.includes(next.filterCol)) {
        next.filterCol = ''
        next.filterVal = ''
      }
      return next
    })
  }, [columns])

  const valid = !!form.table && !!form.tsCol && !!form.producedCol && !!form.rejectedCol
    && form.producedCol !== form.rejectedCol
    && (!form.filterCol || form.filterVal !== '')

  const previewQuery = useQuery({
    queryKey: ['production-log-preview', sourceKey, form],
    queryFn: async () => {
      const common = {
        table: form.table, tsCol: form.tsCol,
        filterCol: form.filterCol || undefined,
        filterVal: form.filterCol ? form.filterVal : undefined,
        datasourceId,
      }
      const [produced, rejected] = await Promise.all([
        fetchSchemaLatest({ ...common, valueCol: form.producedCol }),
        fetchSchemaLatest({ ...common, valueCol: form.rejectedCol }),
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

  function submit() {
    onSave({
      datasource_id: datasourceId ?? null,
      table: form.table,
      ts_col: form.tsCol,
      produced_col: form.producedCol,
      rejected_col: form.rejectedCol,
      filter_col: form.filterCol || null,
      filter_val: form.filterCol ? form.filterVal : null,
    })
  }

  return (
    <Dialog open={open} onClose={onClose} container={container} fullWidth maxWidth="md">
      <DialogTitle>Production Log / ตั้งค่าบันทึกผลผลิต</DialogTitle>
      <DialogContent dividers className={styles.content}>
        <p className={styles.intro}>
          Choose two cumulative counters from the same timestamped row stream.
          Hourly production is calculated from positive counter increments between 08:00 and 18:00.
        </p>

        <div className={styles.grid}>
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
            <span>Good counter / ตัวนับผลิตดี</span>
            <select value={form.producedCol} onChange={(event) => set({ producedCol: event.target.value })} disabled={!columns}>
              <option value="">Select counter…</option>
              {(columns?.value_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          <label>
            <span>Reject counter / ตัวนับของเสีย</span>
            <select value={form.rejectedCol} onChange={(event) => set({ rejectedCol: event.target.value })} disabled={!columns}>
              <option value="">Select counter…</option>
              {(columns?.value_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          <label>
            <span>Filter column / คอลัมน์กรอง</span>
            <select value={form.filterCol} onChange={(event) => set({ filterCol: event.target.value, filterVal: '' })} disabled={!columns}>
              <option value="">No filter</option>
              {(columns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          {form.filterCol && (
            <label className={styles.full}>
              <span>Filter value / ค่าที่กรอง</span>
              <input list="production-log-filter-values" value={form.filterVal} onChange={(event) => set({ filterVal: event.target.value })} />
              <datalist id="production-log-filter-values">
                {filterValues.map((value) => <option key={value} value={value} />)}
              </datalist>
            </label>
          )}
        </div>

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
