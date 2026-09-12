import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import { apiErrorMessage } from '@/api/client'
import { fetchDatasources } from '@/api/datasources'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { groupColumns, pickableColumns } from '@/utils/columnKinds'
import {
  fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues, fetchSchemaLatest,
  fromPrimarySource,
} from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { buildDefectLabelsByCode, resolveTagLabel } from '@/utils/defectLabels'
import { compileExpr, applyExpr } from '@/utils/mathExpr'
import { UNIT_GROUPS } from '@/utils/units'
import styles from './KpiBindingDialog.module.css'

/**
 * KpiBindingDialog — SymbolBindingDialog with everything a headline number
 * has no use for taken out.
 *
 * What is kept is the half that commissions a reading: Connection → Table →
 * Value column → Timestamp → Filter, the column-kind badges, and the live
 * preview. What is dropped is everything that only means something once a
 * reading is *drawn as a symbol* — state maps, beacon colours, run/stop
 * thresholds, alarm limits, the instrument bubble. A box prints a number; it
 * has no states to map and no picture to tint.
 *
 * ## Why the preview is not a nicety here
 *
 * The strip is saved into the layout document unvalidated — `_validate` on the
 * server checks nodes, edges and the production log, and lets `doc.kpis`
 * through untouched. So nothing downstream will ever tell an admin that they
 * picked a column that does not exist. This preview is the only thing standing
 * between a typo and a permanently blank box on a wall display, which is why it
 * shows the *formatted* figure — unit, decimals and expression applied — rather
 * than the raw reading: the question being answered is "is this the number I
 * want up there", not "did the query return".
 */

/** Six is where a float's honest precision runs out for plant instrumentation. */
const DECIMAL_CHOICES = [0, 1, 2, 3, 4, 5, 6]

/**
 * A headline number is a number. Booleans and text columns are deliberately
 * not offered: a box whose whole job is to print a figure large enough to read
 * across a room has nothing useful to do with 'RUN'.
 */
const VALUE_KINDS = ['value_columns']

/**
 * The unit catalogue flattened for a datalist, one entry per distinct suffix.
 *
 * The grouped list is not unique by value — `g` is both a gram and a g-force —
 * which is fine inside a <select>'s optgroups and wrong here: a datalist
 * suggests the *value*, so a duplicate offers the same string twice and keys a
 * React list on something that repeats.
 */
const UNIT_OPTIONS = Array.from(
  new Map(UNIT_GROUPS.flatMap((g) => g.units).map((u) => [u.value, u])).values(),
)

const blank = {
  label: '', labelEn: '',
  datasourceId: '', table: '', valueCol: '', tsCol: '',
  filterCol: '', filterVal: '',
  unit: '', decimals: 0, expr: '',
}

function fromKpi(kpi) {
  if (!kpi) return blank
  const b = kpi.binding ?? {}
  return {
    label: kpi.label ?? '',
    labelEn: kpi.labelEn ?? '',
    datasourceId: b.datasource_id ?? '',
    table: b.table ?? '',
    valueCol: b.value_col ?? '',
    tsCol: b.ts_col ?? '',
    filterCol: b.filter_col ?? '',
    filterVal: b.filter_val ?? '',
    unit: b.unit ?? '',
    decimals: b.decimals ?? 0,
    expr: b.expr ?? '',
  }
}

export default function KpiBindingDialog({ open, kpi, container, onClose, onSave, onRemove }) {
  const [form, setForm] = useState(() => fromKpi(kpi))
  const set = (patch) => setForm((current) => ({ ...current, ...patch }))

  useEffect(() => { if (open) setForm(fromKpi(kpi)) }, [kpi, open])

  const dsId = form.datasourceId === '' ? undefined : Number(form.datasourceId)
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  // Left empty, the connection means "whatever the header points at", which the
  // server resolves to the first selected source. That has to be in the cache
  // key or switching plants would keep offering the previous plant's tables.
  const catalogueKey = dsId ?? `header:${selectionKey}`

  const datasourcesQuery = useQuery({
    queryKey: ['datasources'], queryFn: fetchDatasources, enabled: open,
  })
  const tablesQuery = useQuery({
    queryKey: ['schema-tables', catalogueKey],
    queryFn: () => fetchSchemaTables(dsId),
    enabled: open,
  })
  const columnsQuery = useQuery({
    queryKey: ['schema-columns', catalogueKey, form.table],
    queryFn: () => fetchSchemaColumns(form.table, dsId),
    enabled: open && !!form.table,
  })
  const valuesQuery = useQuery({
    queryKey: ['schema-values', catalogueKey, form.table, form.filterCol],
    queryFn: () => fetchSchemaValues(form.table, form.filterCol, 500, dsId),
    enabled: open && !!form.table && !!form.filterCol,
  })

  // The same query key Reports, Events, Alarms and SymbolBindingDialog use, so
  // this shares their cache entry. An unconfigured camera source yields an
  // empty map and every column keeps its raw name.
  const camerasQuery = useQuery({
    queryKey: ['camera-link-options'],
    queryFn: fetchCameraLinkOptions,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  })
  const labelsByCode = useMemo(
    () => buildDefectLabelsByCode(camerasQuery.data?.cameras),
    [camerasQuery.data],
  )
  const labelFor = useCallback(
    (name) => resolveTagLabel(name, null, labelsByCode),
    [labelsByCode],
  )

  const cols = columnsQuery.data
  const tables = tablesQuery.data || []
  const valueGroups = useMemo(() => groupColumns(cols, VALUE_KINDS), [cols])
  const timestampColumns = cols?.datetime_columns ?? cols?.ts_columns ?? []

  // Clamp the stored selection against what this table actually offers. Asked
  // against exactly the list the picker draws, or a column survives in state
  // while showing as unselected — and then saves.
  useEffect(() => {
    if (!cols) return
    setForm((f) => {
      const next = { ...f }
      if (next.valueCol && !pickableColumns(cols, VALUE_KINDS).includes(next.valueCol)) next.valueCol = ''
      const stamps = cols.datetime_columns ?? cols.ts_columns ?? []
      if (next.tsCol && !stamps.includes(next.tsCol)) next.tsCol = ''
      if (next.filterCol && !cols.filter_columns.includes(next.filterCol)) {
        next.filterCol = ''
        next.filterVal = ''
      }
      return next
    })
  }, [cols])

  const exprError = useMemo(() => {
    const r = compileExpr(form.expr)
    return r.ok ? '' : r.error
  }, [form.expr])

  // A table with no timestamp column is read with LIMIT 1 and no ORDER BY, so
  // an unfiltered binding shows whichever row Postgres happened to hand back.
  // The backend rejects it for symbols; saying so here explains why.
  const needsFilter = !!form.table && !form.tsCol
  const filterMissing = needsFilter && (!form.filterCol || form.filterVal === '')

  const valid = !!form.table && !!form.valueCol && !exprError && !filterMissing

  // --- live preview --------------------------------------------------------
  // Passes the picked connection through rather than the header's primary: the
  // saved binding reads from that source at runtime, so previewing a different
  // plant's number here would make this preview a lie.
  const previewArgs = valid ? {
    table: form.table,
    valueCol: form.valueCol,
    tsCol: form.tsCol || undefined,
    filterCol: form.filterCol || undefined,
    filterVal: form.filterVal || undefined,
    datasourceId: dsId,
  } : null

  const previewQuery = useQuery({
    queryKey: ['kpi-binding-preview', selectionKey, previewArgs],
    queryFn: async () => {
      const res = await fetchSchemaLatest(previewArgs)
      return fromPrimarySource(res.readings, res.sources)
    },
    enabled: open && !!previewArgs,
    retry: false,
  })

  // What the box will actually print, run through the same expression and
  // rounding the strip applies. Showing the raw column here would hide exactly
  // the mistakes an expression introduces.
  const previewText = useMemo(() => {
    const raw = previewQuery.data?.value
    if (raw == null) return null
    const compiled = compileExpr(form.expr)
    const value = compiled.ok ? applyExpr(compiled.fn, raw) : raw
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
    return value.toFixed(Number(form.decimals) || 0)
  }, [previewQuery.data, form.expr, form.decimals])

  function submit() {
    onSave({
      ...kpi,
      label: form.label.trim(),
      labelEn: form.labelEn.trim(),
      binding: {
        datasource_id: dsId ?? null,
        table: form.table,
        value_col: form.valueCol,
        ts_col: form.tsCol || null,
        filter_col: form.filterCol || null,
        filter_val: form.filterCol ? form.filterVal : null,
        unit: form.unit || '',
        decimals: Number(form.decimals) || 0,
        expr: form.expr || '',
      },
    })
  }

  if (!kpi) return null

  return (
    <Dialog open={open} container={container} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle className={styles.title}>
        <span className={styles.titleMain}>Headline number</span>
        <span className={styles.titleSub}>ตัวเลขหัวจอ · {kpi.id}</span>
      </DialogTitle>

      <DialogContent dividers className={styles.content}>
        <div className={styles.sheet}>
          {/* --- signal ------------------------------------------------------ */}
          <section className={styles.col}>
            <h4 className={styles.colTitle}>Signal</h4>

            <label className={styles.field}>
              <span>Connection</span>
              <select
                value={form.datasourceId}
                onChange={(e) => set({
                  datasourceId: e.target.value, table: '', valueCol: '', tsCol: '', filterCol: '', filterVal: '',
                })}
              >
                <option value="">Follow header selection</option>
                {(datasourcesQuery.data || []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <p className={styles.note}>
              Where this box reads from, not just what it browses. Left on the
              header it tracks whichever source is primary there; pick one and it
              reads that plant whatever the header selects — so two boxes in the
              strip may legitimately watch two different plants.
            </p>

            <label className={styles.field}>
              <span>Table</span>
              <select
                value={form.table}
                onChange={(e) => set({
                  table: e.target.value, valueCol: '', tsCol: '', filterCol: '', filterVal: '',
                })}
              >
                <option value="">Select a table…</option>
                {tables.map((t) => (
                  <option key={t.table} value={t.table}>{t.label ?? t.table}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>Value column</span>
              {/* Badged with the real Postgres type: `enabled` and
                  `enabled_count` are indistinguishable by name, and picking the
                  wrong one only shows up once the strip is live in front of a
                  shift. An <option> carries no markup, so the badge rides in
                  the text. */}
              <select
                value={form.valueCol}
                disabled={!cols}
                onChange={(e) => set({ valueCol: e.target.value })}
              >
                <option value="">—</option>
                {valueGroups.flatMap((g) => g.options).map((o) => (
                  <option key={o.name} value={o.name}>{labelFor(o.name)} · {o.badge}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>Timestamp column</span>
              <select
                value={form.tsCol}
                disabled={!cols}
                onChange={(e) => set({ tsCol: e.target.value })}
              >
                <option value="">None — current-state table</option>
                {timestampColumns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label className={styles.field}>
              <span>Filter column</span>
              <select
                value={form.filterCol}
                disabled={!cols}
                onChange={(e) => set({ filterCol: e.target.value, filterVal: '' })}
              >
                <option value="">No filter</option>
                {(cols?.filter_columns ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            {form.filterCol && (
              <label className={styles.field}>
                <span>Filter value</span>
                <input
                  list="kpi-filter-values"
                  value={form.filterVal}
                  onChange={(e) => set({ filterVal: e.target.value })}
                />
                <datalist id="kpi-filter-values">
                  {(valuesQuery.data || []).map((v) => <option key={v} value={v} />)}
                </datalist>
              </label>
            )}

            {filterMissing && (
              <p className={styles.error}>
                This table has no timestamp column, so there is no newest row to
                read. Pick a filter that narrows it to the one row this box means.
              </p>
            )}
          </section>

          {/* --- presentation ------------------------------------------------ */}
          <section className={styles.col}>
            <h4 className={styles.colTitle}>Presentation</h4>

            <label className={styles.field}>
              <span>Label (ไทย)</span>
              <input
                value={form.label}
                onChange={(e) => set({ label: e.target.value })}
                placeholder="ผลิตได้วันนี้"
              />
            </label>

            <label className={styles.field}>
              <span>Label (English)</span>
              <input
                value={form.labelEn}
                onChange={(e) => set({ labelEn: e.target.value })}
                placeholder="Produced today"
              />
            </label>

            <label className={styles.field}>
              <span>Unit</span>
              <input
                list="kpi-units"
                value={form.unit}
                onChange={(e) => set({ unit: e.target.value })}
                placeholder="ชิ้น / pcs"
              />
              {/* A datalist rather than a select: the catalogue covers physical
                  units, and a production strip counts things it has no SI name
                  for — pieces, pallets, cartons, ชิ้น. */}
              <datalist id="kpi-units">
                {UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </datalist>
            </label>

            <label className={styles.field}>
              <span>Decimals</span>
              <select
                className={styles.mono}
                value={form.decimals}
                onChange={(e) => set({ decimals: e.target.value })}
              >
                {DECIMAL_CHOICES.map((d) => (
                  <option key={d} value={d}>{d} · {(1234.56789).toFixed(d)}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>Expression</span>
              <input
                className={styles.mono}
                value={form.expr}
                onChange={(e) => set({ expr: e.target.value })}
                placeholder="a / 10"
              />
            </label>
            {exprError
              ? <p className={styles.error}>{exprError}</p>
              : <p className={styles.note}>`a` is the raw reading. Leave empty to print it as stored.</p>}

            <div className={styles.preview}>
              <span className={styles.previewLabel}>
                {form.label || form.labelEn || 'Preview'}
              </span>
              <span className={styles.previewValue}>
                {previewQuery.isError ? '—'
                  : previewQuery.isPending && previewArgs ? '…'
                    : previewText ?? '—'}
                {form.unit && previewText != null && <i>{form.unit}</i>}
              </span>
              <span className={styles.previewNote}>
                {!previewArgs ? 'Pick a table and a value column to read one.'
                  : previewQuery.isError
                    // Never the raw `detail`: a fan-out failure answers with an
                    // object ({error, sources}), and rendering that as a React
                    // child takes the whole page down.
                    ? apiErrorMessage(previewQuery.error, 'That binding returned no reading.')
                    : 'Latest reading, as this box will print it.'}
              </span>
            </div>
          </section>
        </div>
      </DialogContent>

      <DialogActions>
        <Button color="error" onClick={onRemove}>Remove box</Button>
        <span className={styles.spacer} />
        <Button color="inherit" onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={submit}>Use this reading</Button>
      </DialogActions>
    </Dialog>
  )
}
