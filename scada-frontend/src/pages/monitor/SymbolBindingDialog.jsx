import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import { fetchDatasources } from '@/api/datasources'
import { fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues, fetchSchemaLatest } from '@/api/schema'
import { symbolDef } from '@/components/mimic/symbols'
import InstrumentBubble from '@/components/mimic/InstrumentBubble'
import { deriveTag } from '@/components/mimic/deriveTag'
import { compileExpr } from '@/utils/mathExpr'
import { UNIT_GROUPS } from '@/utils/units'
import styles from './SymbolBindingDialog.module.css'

/** Beacon-style symbols map a coded number onto a named state. */
const DEFAULT_MAP = { 0: 'green', 1: 'amber', 2: 'red' }

const num = (v) => (v === '' || v == null ? null : Number(v))
const str = (v) => (v === '' || v == null ? null : v)

/** Blank form for an unbound symbol — every field empty, nothing assumed. */
function emptyForm(node) {
  return {
    label: node?.label ?? '',
    tagId: node?.tagId ?? '',
    datasourceId: '',
    table: '',
    valueCol: '',
    tsCol: '',
    filterCol: '',
    filterVal: '',
    expr: '',
    unit: '',
    decimals: 1,
    rangeLo: '',
    rangeHi: '',
    warnLo: '',
    warnHi: '',
    critLo: '',
    critHi: '',
    stateMode: 'none',
    runAbove: 0.5,
    invert: false,
    map: DEFAULT_MAP,
  }
}

function formFromNode(node) {
  const base = emptyForm(node)
  const b = node?.binding
  if (!b) return base
  const lim = b.limits || {}
  return {
    ...base,
    datasourceId: b.datasource_id ?? '',
    table: b.table ?? '',
    valueCol: b.value_col ?? '',
    tsCol: b.ts_col ?? '',
    filterCol: b.filter_col ?? '',
    filterVal: b.filter_val ?? '',
    expr: b.expr ?? '',
    unit: b.unit ?? '',
    decimals: b.decimals ?? 1,
    rangeLo: b.range?.[0] ?? '',
    rangeHi: b.range?.[1] ?? '',
    warnLo: lim.warnLo ?? '',
    warnHi: lim.warnHi ?? '',
    critLo: lim.critLo ?? '',
    critHi: lim.critHi ?? '',
    stateMode: b.state?.mode ?? 'none',
    runAbove: b.state?.runAbove ?? 0.5,
    invert: b.state?.invert ?? false,
    map: b.state?.map ?? DEFAULT_MAP,
  }
}

function bindingFromForm(f) {
  const hasRange = f.rangeLo !== '' && f.rangeHi !== ''
  return {
    datasource_id: f.datasourceId === '' ? null : Number(f.datasourceId),
    table: f.table,
    value_col: f.valueCol,
    ts_col: str(f.tsCol),
    filter_col: str(f.filterCol),
    filter_val: f.filterCol ? str(f.filterVal) : null,
    expr: f.expr || '',
    unit: f.unit || '',
    decimals: Number(f.decimals) || 0,
    range: hasRange ? [Number(f.rangeLo), Number(f.rangeHi)] : null,
    limits: {
      warnLo: num(f.warnLo), warnHi: num(f.warnHi),
      critLo: num(f.critLo), critHi: num(f.critHi),
    },
    state: f.stateMode === 'none' ? null : {
      mode: f.stateMode,
      runAbove: Number(f.runAbove) || 0,
      invert: !!f.invert,
      map: f.map,
    },
  }
}

/**
 * SymbolBindingDialog — points one symbol at one column of one database.
 *
 * The cascade is the same *shape* as the Live panel editor's, written fresh
 * because a symbol is one device on one row: Live's version carries
 * `value_cols[]` and `filters[]` for multi-series panels, and bending it to
 * this case would put the app's busiest page at risk to save forty lines.
 *
 * The dialog's signature is the preview: the right column draws the **actual
 * symbol and its ISA balloon**, using the same components the canvas uses, fed
 * by a real reading from the binding as configured. Commissioning a loop is
 * then a WYSIWYG act — you see the instrument you are about to put on the wall,
 * not a form you hope you filled in correctly. It is laid out as an instrument
 * datasheet rather than a stack of MUI fields for the same reason.
 */
export default function SymbolBindingDialog({ open, node, onClose, onSave }) {
  const [form, setForm] = useState(() => formFromNode(node))
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  // Reopening on a different symbol must not inherit the last one's draft.
  useEffect(() => {
    if (open) setForm(formFromNode(node))
  }, [open, node])

  const def = node ? symbolDef(node) : null
  const supportsState = def?.binding === 'both' || def?.binding === 'discrete'

  const dsId = form.datasourceId === '' ? undefined : Number(form.datasourceId)

  const datasourcesQuery = useQuery({
    queryKey: ['datasources'], queryFn: fetchDatasources, enabled: open,
  })
  const tablesQuery = useQuery({
    queryKey: ['schema-tables', dsId ?? null],
    queryFn: () => fetchSchemaTables(dsId),
    enabled: open,
  })
  const columnsQuery = useQuery({
    queryKey: ['schema-columns', dsId ?? null, form.table],
    queryFn: () => fetchSchemaColumns(form.table, dsId),
    enabled: open && !!form.table,
  })
  const valuesQuery = useQuery({
    queryKey: ['schema-values', dsId ?? null, form.table, form.filterCol],
    queryFn: () => fetchSchemaValues(form.table, form.filterCol, 500, dsId),
    enabled: open && !!form.table && !!form.filterCol,
  })

  const cols = columnsQuery.data
  const tables = tablesQuery.data || []

  // Clamp every downstream field to what the newly loaded level actually
  // offers. Without this a table switch leaves the previous table's column
  // selected and the save 400s with a column that isn't there.
  useEffect(() => {
    if (!cols) return
    setForm((f) => {
      const next = { ...f }
      if (f.valueCol && !cols.value_columns.includes(f.valueCol)) next.valueCol = ''
      if (!next.valueCol) next.valueCol = cols.value_columns[0] ?? ''
      if (f.tsCol && !cols.ts_columns.includes(f.tsCol)) next.tsCol = ''
      if (f.filterCol && !cols.filter_columns.includes(f.filterCol)) {
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
  // an unfiltered binding would show whichever row Postgres handed back. The
  // backend rejects it too; catching it here explains *why* instead of 400ing.
  const needsFilter = !!form.table && !form.tsCol
  const filterMissing = needsFilter && (!form.filterCol || form.filterVal === '')

  const valid = !!form.table && !!form.valueCol && !exprError && !filterMissing

  // --- live preview ---------------------------------------------------------
  const previewArgs = valid ? {
    table: form.table,
    valueCol: form.valueCol,
    tsCol: form.tsCol || undefined,
    filterCol: form.filterCol || undefined,
    filterVal: form.filterVal || undefined,
    datasourceId: dsId,
  } : null

  const previewQuery = useQuery({
    queryKey: ['binding-preview', previewArgs],
    queryFn: () => fetchSchemaLatest(previewArgs),
    enabled: open && !!previewArgs,
    retry: false,
  })

  const previewNode = useMemo(() => (node ? {
    ...node,
    x: 0,
    y: 0,
    tagId: form.tagId || node.tagId,
    label: form.label || node.label,
    binding: bindingFromForm(form),
  } : null), [node, form])

  const previewTag = useMemo(() => {
    if (!previewNode || previewQuery.data?.value == null) return null
    const raw = previewQuery.data
    const { entry } = deriveTag({
      node: previewNode,
      reading: { value: raw.value, ts: raw.ts ? new Date(raw.ts).getTime() : Date.now() },
      prev: null,
      now: Date.now(),
      // The probe is a one-shot read, not a poll — a generous window keeps a
      // legitimately slow source from previewing as stale.
      pollSeconds: 3600,
    })
    return entry
  }, [previewNode, previewQuery.data])

  function handleSave() {
    onSave({
      tagId: form.tagId.trim() || null,
      label: form.label.trim() || node.label,
      binding: bindingFromForm(form),
    })
  }

  function handleDisconnect() {
    onSave({ tagId: form.tagId.trim() || null, label: form.label.trim() || node.label, binding: null })
  }

  if (!node) return null

  // Preview canvas: the symbol at its true size plus room for the balloon,
  // which hangs outside the node box by design.
  const pad = 110
  const vbW = node.w + pad * 2
  const vbH = node.h + pad * 2
  const bubble = def?.bubble
  const ax = pad + (bubble ? bubble.anchor[0] * node.w : 0)
  const ay = pad + (bubble ? bubble.anchor[1] * node.h : 0)

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle className={styles.title}>
        <span className={styles.titleMain}>Connect data source</span>
        <span className={styles.titleSub}>{def?.label} · {node.id}</span>
      </DialogTitle>

      <DialogContent className={styles.content}>
        <div className={styles.sheet}>
          {/* --- signal ---------------------------------------------------- */}
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
                <option value="">Default (app database)</option>
                {(datasourcesQuery.data || []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>

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
              <select
                value={form.valueCol}
                disabled={!cols}
                onChange={(e) => set({ valueCol: e.target.value })}
              >
                <option value="">—</option>
                {(cols?.value_columns || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label className={styles.field}>
              <span>Timestamp column</span>
              <select
                value={form.tsCol}
                disabled={!cols}
                onChange={(e) => set({ tsCol: e.target.value })}
              >
                <option value="">None — current value only</option>
                {(cols?.ts_columns || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label className={styles.field}>
              <span>Device column</span>
              <select
                value={form.filterCol}
                disabled={!cols}
                onChange={(e) => set({ filterCol: e.target.value, filterVal: '' })}
              >
                <option value="">None — whole table</option>
                {(cols?.filter_columns || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label className={styles.field}>
              <span>Device</span>
              <select
                value={form.filterVal}
                disabled={!form.filterCol || valuesQuery.isPending}
                onChange={(e) => set({ filterVal: e.target.value })}
              >
                <option value="">—</option>
                {(valuesQuery.data || []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>

            {filterMissing && (
              <p className={styles.note}>
                This table has no timestamp column, so the reading has to be pinned to one
                device — pick a device column and a value.
              </p>
            )}

            {columnsQuery.isError && (
              <Alert severity="error" className={styles.alert}>
                {columnsQuery.error?.response?.data?.detail || 'Could not read that table.'}
              </Alert>
            )}
          </section>

          {/* --- presentation ---------------------------------------------- */}
          <section className={styles.col}>
            <h4 className={styles.colTitle}>Presentation</h4>

            <label className={styles.field}>
              <span>Asset name</span>
              <input value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="D-200 steam drum" />
            </label>

            <label className={styles.field}>
              <span>Tag id</span>
              <input
                className={styles.mono}
                value={form.tagId}
                onChange={(e) => set({ tagId: e.target.value })}
                placeholder="LT-102"
              />
            </label>

            <label className={styles.field}>
              <span>Unit</span>
              <select value={form.unit} onChange={(e) => set({ unit: e.target.value })}>
                <option value="">None</option>
                {UNIT_GROUPS.map((g) => (
                  <optgroup key={g.category} label={g.category}>
                    {g.units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>

            <div className={styles.row}>
              <label className={styles.field}>
                <span>Decimals</span>
                <input className={styles.mono} type="number" min="0" max="6" value={form.decimals} onChange={(e) => set({ decimals: e.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Range min</span>
                <input className={styles.mono} type="number" value={form.rangeLo} onChange={(e) => set({ rangeLo: e.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Range max</span>
                <input className={styles.mono} type="number" value={form.rangeHi} onChange={(e) => set({ rangeHi: e.target.value })} />
              </label>
            </div>

            <div className={styles.row}>
              <label className={styles.field}>
                <span>Warn lo</span>
                <input className={styles.mono} type="number" value={form.warnLo} onChange={(e) => set({ warnLo: e.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Warn hi</span>
                <input className={styles.mono} type="number" value={form.warnHi} onChange={(e) => set({ warnHi: e.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Crit lo</span>
                <input className={styles.mono} type="number" value={form.critLo} onChange={(e) => set({ critLo: e.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Crit hi</span>
                <input className={styles.mono} type="number" value={form.critHi} onChange={(e) => set({ critHi: e.target.value })} />
              </label>
            </div>

            <label className={styles.field}>
              <span>Expression</span>
              <input
                className={styles.mono}
                value={form.expr}
                onChange={(e) => set({ expr: e.target.value })}
                placeholder="value / 10"
              />
            </label>
            {exprError && <p className={styles.error}>{exprError}</p>}

            {supportsState && (
              <>
                <h4 className={styles.colTitle}>State</h4>
                <label className={styles.field}>
                  <span>Derived from</span>
                  <select value={form.stateMode} onChange={(e) => set({ stateMode: e.target.value })}>
                    <option value="none">Nothing — analog only</option>
                    <option value="threshold">Threshold — running above a value</option>
                    <option value="map">Map — coded value to state</option>
                  </select>
                </label>

                {form.stateMode === 'threshold' && (
                  <div className={styles.row}>
                    <label className={styles.field}>
                      <span>Running above</span>
                      <input className={styles.mono} type="number" value={form.runAbove} onChange={(e) => set({ runAbove: e.target.value })} />
                    </label>
                    <label className={styles.check}>
                      <input type="checkbox" checked={form.invert} onChange={(e) => set({ invert: e.target.checked })} />
                      <span>Invert (running below)</span>
                    </label>
                  </div>
                )}

                {form.stateMode === 'map' && (
                  <div className={styles.row}>
                    {Object.keys(form.map).map((k) => (
                      <label className={styles.field} key={k}>
                        <span>{`Value ${k}`}</span>
                        <input
                          className={styles.mono}
                          value={form.map[k]}
                          onChange={(e) => set({ map: { ...form.map, [k]: e.target.value } })}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <p className={styles.note}>
                  /api/schema/latest returns a number, so a run/stop state is derived from the
                  reading rather than read from a text column.
                </p>
              </>
            )}
          </section>

          {/* --- preview --------------------------------------------------- */}
          <section className={`${styles.col} ${styles.previewCol}`}>
            <h4 className={styles.colTitle}>Preview</h4>
            <div className={styles.preview}>
              <svg viewBox={`0 0 ${vbW} ${vbH}`} className={styles.previewSvg} role="img" aria-label="Symbol preview">
                <g transform={`translate(${pad} ${pad})`}>
                  <def.Component node={previewNode} tag={previewTag} selected={false} />
                </g>
                {bubble && (
                  <InstrumentBubble
                    tag={previewTag}
                    tagId={form.tagId}
                    anchorX={ax}
                    anchorY={ay}
                    cx={ax + bubble.offset[0]}
                    cy={ay + bubble.offset[1]}
                  />
                )}
              </svg>
            </div>

            <dl className={styles.readout}>
              <dt>Reading</dt>
              <dd className={styles.mono}>
                {previewQuery.isError ? 'connection error'
                  : previewQuery.isPending && previewArgs ? 'reading…'
                    : previewQuery.data?.value != null ? String(previewQuery.data.value) : '—'}
              </dd>
              <dt>Shown as</dt>
              <dd className={styles.mono}>
                {previewTag ? `${previewTag.display} ${previewTag.unit}`.trim() : '—'}
              </dd>
              <dt>Status</dt>
              <dd className={styles.mono}>{previewTag?.status ?? '—'}</dd>
              <dt>State</dt>
              <dd className={styles.mono}>{previewTag?.state ?? '—'}</dd>
            </dl>

            {previewQuery.isError && (
              <Alert severity="warning" className={styles.alert}>
                {previewQuery.error?.response?.data?.detail || 'No reading from that binding yet.'}
              </Alert>
            )}
          </section>
        </div>
      </DialogContent>

      <DialogActions className={styles.actions}>
        {node.binding && (
          <Button color="inherit" onClick={handleDisconnect}>Disconnect</Button>
        )}
        <span className={styles.spacer} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid} onClick={handleSave}>
          Use this source
        </Button>
      </DialogActions>
    </Dialog>
  )
}
