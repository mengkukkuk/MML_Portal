import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import { fetchSchemaColumns, fetchSchemaTables, fetchSchemaValues } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import styles from './CameraDefectDialog.module.css'

/**
 * CameraDefectDialog — points one drawing at the vision system's defect counters.
 *
 * The counters used to be two hardcoded tables in the app database, which meant
 * one plant, one line, five defect categories, forever. They now live wherever
 * the line's own vision schema is, so this is where an admin says which table
 * and which columns — the same shape as ProductionLogDialog, one binding per
 * mimic rather than per symbol, because every ipcamera on a drawing reads the
 * same line.
 *
 * The defect columns are an ordered list and are edited as one: slot N is
 * `defect_cols[N-1]`, and that position is also the `defect_N` folder the vision
 * system writes its frames into. Reordering therefore re-points the contact
 * sheets, so the editor appends and removes and never sorts.
 */

const MAX_SLOTS = 32

const blank = {
  datasourceId: '',
  table: '',
  cameraCol: '',
  batchCol: '',
  tsCol: '',
  defectCols: [],
  registryOn: false,
  regTable: '',
  codeCol: '',
  nameCol: '',
  stationCol: '',
  labelCols: [],
}

function fromBinding(binding) {
  if (!binding) return blank
  const registry = binding.registry ?? null
  return {
    datasourceId: binding.datasource_id ?? '',
    table: binding.table ?? '',
    cameraCol: binding.camera_col ?? '',
    batchCol: binding.batch_col ?? '',
    tsCol: binding.ts_col ?? '',
    defectCols: [...(binding.defect_cols ?? [])],
    registryOn: !!registry,
    regTable: registry?.table ?? '',
    codeCol: registry?.code_col ?? '',
    nameCol: registry?.name_col ?? '',
    stationCol: registry?.station_col ?? '',
    labelCols: (registry?.label_cols ?? []).map((column) => column ?? ''),
  }
}

/** `defect_2` before `defect_10` — the vision system numbers, it does not pad. */
function bySlotNumber(a, b) {
  const na = Number(a.match(/(\d+)/)?.[1] ?? 0)
  const nb = Number(b.match(/(\d+)/)?.[1] ?? 0)
  return na - nb || a.localeCompare(b)
}

export default function CameraDefectDialog({ open, binding, container, onClose, onSave }) {
  const [form, setForm] = useState(() => fromBinding(binding))
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

  useEffect(() => { if (open) setForm(fromBinding(binding)) }, [binding, open])

  const datasourceId = form.datasourceId === '' ? undefined : Number(form.datasourceId)
  const selectionKey = useDatasourceSelectionStore((state) => state.selectionKey)
  const selectedDatasources = useDatasourceSelectionStore((state) => state.selected)
  const primaryDatasource = selectedDatasources[0]
  const sourceKey = datasourceId ?? `header:${selectionKey}`

  const tablesQuery = useQuery({
    queryKey: ['schema-tables', sourceKey],
    queryFn: () => fetchSchemaTables(datasourceId),
    enabled: open,
  })
  const columnsQuery = useQuery({
    queryKey: ['schema-columns', sourceKey, form.table],
    queryFn: () => fetchSchemaColumns(form.table, datasourceId),
    enabled: open && !!form.table,
  })
  const regColumnsQuery = useQuery({
    queryKey: ['schema-columns', sourceKey, form.regTable],
    queryFn: () => fetchSchemaColumns(form.regTable, datasourceId),
    enabled: open && form.registryOn && !!form.regTable,
  })

  const columns = columnsQuery.data
  const regColumns = regColumnsQuery.data

  // Drop anything the newly-described table cannot supply, and — only when the
  // slot list is still empty — offer the conventional layout so the common case
  // opens pre-filled instead of asking for five identical picks.
  useEffect(() => {
    if (!columns) return
    setForm((current) => {
      const next = { ...current }
      if (!columns.filter_columns.includes(next.cameraCol)) {
        // `id` is excluded for the same reason as the registry's code column
        // below: it is a per-database serial, not the camera's identity.
        const candidates = columns.filter_columns.filter((c) => !/^id$/i.test(c))
        next.cameraCol = candidates.find((c) => /cam/i.test(c)) ?? candidates[0] ?? ''
      }
      if (next.batchCol && !columns.value_columns.includes(next.batchCol)) next.batchCol = ''
      if (next.tsCol && !columns.ts_columns.includes(next.tsCol)) next.tsCol = ''
      if (!next.batchCol && !next.tsCol) {
        next.batchCol = columns.value_columns.find((c) => /batch/i.test(c)) ?? ''
        next.tsCol = columns.ts_columns[0] ?? ''
      }
      next.defectCols = next.defectCols.filter((c) => columns.value_columns.includes(c))
      if (next.defectCols.length === 0) {
        next.defectCols = columns.value_columns
          .filter((c) => /^defect[_-]?\d+$/i.test(c))
          .sort(bySlotNumber)
          .slice(0, MAX_SLOTS)
      }
      return next
    })
  }, [columns])

  useEffect(() => {
    if (!regColumns) return
    setForm((current) => {
      const next = { ...current }
      if (!regColumns.filter_columns.includes(next.codeCol)) {
        // Never `id`: a registry's surrogate key is a per-database serial that
        // means something else in the next line's schema, while the code is what
        // the defect rows actually carry. Guessing `id` here would produce a
        // camera list that silently matches nothing.
        const candidates = regColumns.filter_columns.filter((c) => !/^id$/i.test(c))
        next.codeCol = candidates.find((c) => /^code$/i.test(c))
          ?? candidates.find((c) => /code/i.test(c))
          ?? candidates[0] ?? ''
      }
      for (const key of ['nameCol', 'stationCol']) {
        if (next[key] && !regColumns.filter_columns.includes(next[key])) next[key] = ''
      }
      // A slot keeps its label if the registry still has that column; otherwise
      // the `<defect column>_label` convention is tried, which is what the
      // vision system's own registry uses and saves five identical picks.
      next.labelCols = next.defectCols.map((defectCol, index) => {
        const chosen = next.labelCols[index]
        if (chosen && regColumns.filter_columns.includes(chosen)) return chosen
        const conventional = `${defectCol}_label`
        return regColumns.filter_columns.includes(conventional) ? conventional : ''
      })
      return next
    })
  }, [regColumns])

  const valueColumns = columns?.value_columns ?? []
  const tableOptions = tablesQuery.data ?? []

  function setSlot(index, column) {
    setForm((current) => {
      const defectCols = [...current.defectCols]
      defectCols[index] = column
      return { ...current, defectCols }
    })
  }

  function setLabel(index, column) {
    setForm((current) => {
      const labelCols = [...current.labelCols]
      while (labelCols.length <= index) labelCols.push('')
      labelCols[index] = column
      return { ...current, labelCols }
    })
  }

  function addSlot() {
    setForm((current) => {
      const free = valueColumns.find((c) => !current.defectCols.includes(c))
      if (!free) return current
      return { ...current, defectCols: [...current.defectCols, free] }
    })
  }

  function removeSlot(index) {
    setForm((current) => ({
      ...current,
      // The labels are addressed by slot, so a removal has to shift them too.
      defectCols: current.defectCols.filter((_, i) => i !== index),
      labelCols: current.labelCols.filter((_, i) => i !== index),
    }))
  }

  const duplicated = new Set(
    form.defectCols.filter((c, i) => form.defectCols.indexOf(c) !== i),
  )
  const valid = !!form.table && !!form.cameraCol
    && form.defectCols.length > 0 && form.defectCols.every(Boolean)
    && duplicated.size === 0
    && (!!form.batchCol || !!form.tsCol)
    && (!form.registryOn || (!!form.regTable && !!form.codeCol))

  const camerasQuery = useQuery({
    queryKey: ['schema-values', sourceKey, form.table, form.cameraCol],
    queryFn: () => fetchSchemaValues(form.table, form.cameraCol, 50, datasourceId),
    enabled: open && !!form.table && !!form.cameraCol,
    retry: false,
  })
  const cameraCodes = useMemo(() => camerasQuery.data ?? [], [camerasQuery.data])

  function submit() {
    const labelCols = form.labelCols
      .slice(0, form.defectCols.length)
      .map((column) => column || null)
    onSave({
      datasource_id: datasourceId ?? null,
      table: form.table,
      camera_col: form.cameraCol,
      batch_col: form.batchCol || null,
      ts_col: form.tsCol || null,
      defect_cols: form.defectCols,
      registry: form.registryOn
        ? {
          table: form.regTable,
          code_col: form.codeCol,
          name_col: form.nameCol || null,
          station_col: form.stationCol || null,
          label_cols: labelCols.some(Boolean) ? labelCols : null,
        }
        : null,
    })
  }

  return (
    <Dialog open={open} onClose={onClose} container={container} fullWidth maxWidth="md">
      <DialogTitle>Camera defects / ตั้งค่าข้อมูลกล้องตรวจสอบ</DialogTitle>
      <DialogContent dividers className={styles.content}>
        <p className={styles.intro}>
          Point this drawing at the vision system&rsquo;s defect counters. Every
          camera symbol on the drawing reads from here, and the cameras it can be
          linked to are the distinct values of the camera column below.
        </p>

        <div className={styles.grid}>
          <label>
            <span>Datasource / แหล่งข้อมูล</span>
            <select
              value={form.datasourceId}
              onChange={(event) => set({ datasourceId: event.target.value, table: '', regTable: '' })}
            >
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
            <span>Defect table / ตารางข้อมูลตำหนิ</span>
            <select value={form.table} onChange={(event) => set({ table: event.target.value, defectCols: [] })}>
              <option value="">Select table…</option>
              {tableOptions.map((table) => (
                <option key={table.table} value={table.table}>{table.label ?? table.table}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Camera column / คอลัมน์กล้อง</span>
            <select value={form.cameraCol} onChange={(event) => set({ cameraCol: event.target.value })} disabled={!columns}>
              <option value="">Select column…</option>
              {(columns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          <label>
            <span>Batch column / คอลัมน์รอบผลิต</span>
            <select value={form.batchCol} onChange={(event) => set({ batchCol: event.target.value })} disabled={!columns}>
              <option value="">None</option>
              {valueColumns.map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>

          <label>
            <span>Timestamp / เวลา</span>
            <select value={form.tsCol} onChange={(event) => set({ tsCol: event.target.value })} disabled={!columns}>
              <option value="">None</option>
              {(columns?.ts_columns ?? []).map((column) => <option key={column}>{column}</option>)}
            </select>
          </label>
        </div>

        {columns && !form.batchCol && !form.tsCol && (
          <Alert severity="warning">
            Choose a batch column or a timestamp column — one of the two is needed
            to tell which inspection round is the newest.
          </Alert>
        )}

        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Defect slots / ช่องตำหนิ</span>
          </div>
          <p className={styles.hint}>
            One row per defect category, in order. Slot 1 is also the{' '}
            <code>defect_1</code> frame folder the vision system writes to, so
            removing a slot re-numbers everything below it — add at the end when
            a new category appears.
          </p>

          <div className={styles.slots}>
            {form.defectCols.map((column, index) => (
              // Keyed by position, not by column: slot identity *is* the
              // position, and two slots may sit on one column mid-edit, which a
              // column key would collapse into one row.
              <div key={index} className={styles.slot}>
                <span className={styles.slotNo}>{index + 1}</span>
                <select value={column} onChange={(event) => setSlot(index, event.target.value)}>
                  {!valueColumns.includes(column) && <option value={column}>{column} (missing)</option>}
                  {valueColumns.map((option) => (
                    <option
                      key={option}
                      value={option}
                      disabled={option !== column && form.defectCols.includes(option)}
                    >
                      {option}
                    </option>
                  ))}
                </select>
                {form.registryOn ? (
                  <select
                    value={form.labelCols[index] ?? ''}
                    onChange={(event) => setLabel(index, event.target.value)}
                    disabled={!regColumns}
                  >
                    <option value="">Numbered label</option>
                    {(regColumns?.filter_columns ?? []).map((option) => <option key={option}>{option}</option>)}
                  </select>
                ) : <span />}
                <button
                  type="button"
                  className={styles.slotDrop}
                  aria-label={`Remove slot ${index + 1}`}
                  onClick={() => removeSlot(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <Button
            className={styles.addSlot}
            size="small"
            color="inherit"
            disabled={!columns || form.defectCols.length >= MAX_SLOTS
              || form.defectCols.length >= valueColumns.length}
            onClick={addSlot}
          >
            Add slot
          </Button>

          {duplicated.size > 0 && (
            <Alert severity="warning">
              Each slot needs its own column — {[...duplicated].join(', ')} is used twice.
            </Alert>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Camera registry / ทะเบียนกล้อง</span>
          </div>
          <p className={styles.hint}>
            Optional. Without it a camera is listed by the code found in the defect
            rows, and each slot is labelled by its number. With it, cameras carry
            their name and station, and slots carry the names on the label columns above.
          </p>

          <div className={styles.grid}>
            <label>
              <span>Registry table / ตารางทะเบียน</span>
              <select
                value={form.registryOn ? form.regTable : ''}
                onChange={(event) => set({
                  regTable: event.target.value,
                  registryOn: !!event.target.value,
                  ...(event.target.value ? {} : { codeCol: '', nameCol: '', stationCol: '', labelCols: [] }),
                })}
              >
                <option value="">No registry</option>
                {tableOptions.map((table) => (
                  <option key={table.table} value={table.table}>{table.label ?? table.table}</option>
                ))}
              </select>
            </label>

            {form.registryOn && (
              <>
                <label>
                  <span>Code column / คอลัมน์รหัส</span>
                  <select value={form.codeCol} onChange={(event) => set({ codeCol: event.target.value })} disabled={!regColumns}>
                    <option value="">Select column…</option>
                    {(regColumns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
                  </select>
                </label>

                <label>
                  <span>Name column / คอลัมน์ชื่อ</span>
                  <select value={form.nameCol} onChange={(event) => set({ nameCol: event.target.value })} disabled={!regColumns}>
                    <option value="">None</option>
                    {(regColumns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
                  </select>
                </label>

                <label>
                  <span>Station column / คอลัมน์สถานี</span>
                  <select value={form.stationCol} onChange={(event) => set({ stationCol: event.target.value })} disabled={!regColumns}>
                    <option value="">None</option>
                    {(regColumns?.filter_columns ?? []).map((column) => <option key={column}>{column}</option>)}
                  </select>
                </label>
              </>
            )}
          </div>
        </div>

        {camerasQuery.isError && (
          <Alert severity="warning">The camera column could not be read from this table.</Alert>
        )}
        {cameraCodes.length > 0 && (
          <p className={styles.hint}>
            {cameraCodes.length} camera{cameraCodes.length === 1 ? '' : 's'} found:{' '}
            {cameraCodes.slice(0, 8).join(', ')}{cameraCodes.length > 8 ? '…' : ''}
          </p>
        )}
      </DialogContent>
      <DialogActions>
        {binding && <Button color="error" onClick={() => onSave(null)}>Remove configuration</Button>}
        <span className={styles.spacer} />
        <Button color="inherit" onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={submit}>Use these counters</Button>
      </DialogActions>
    </Dialog>
  )
}
