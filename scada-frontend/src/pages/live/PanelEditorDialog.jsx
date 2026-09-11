import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import ListSubheader from '@mui/material/ListSubheader'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Alert from '@mui/material/Alert'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CloseIcon from '@mui/icons-material/Close'
import ShowChartOutlinedIcon from '@mui/icons-material/ShowChartOutlined'
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined'
import SpeedOutlinedIcon from '@mui/icons-material/SpeedOutlined'
import ExploreOutlinedIcon from '@mui/icons-material/ExploreOutlined'
import SortOutlinedIcon from '@mui/icons-material/SortOutlined'
import EqualizerOutlinedIcon from '@mui/icons-material/EqualizerOutlined'
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined'
import PieChartOutlinedIcon from '@mui/icons-material/PieChartOutlined'
import GridOnOutlinedIcon from '@mui/icons-material/GridOnOutlined'
import ScatterPlotOutlinedIcon from '@mui/icons-material/ScatterPlotOutlined'
import ViewTimelineOutlinedIcon from '@mui/icons-material/ViewTimelineOutlined'
import CandlestickChartOutlinedIcon from '@mui/icons-material/CandlestickChartOutlined'
import { fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues } from '@/api/schema'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { createPanel, updatePanel } from '@/api/panels'
import { colorAt } from '@/utils/seriesPalette'
import { COMPARATOR_OPS } from '@/utils/alertConditions'
import { UNIT_GROUPS } from '@/utils/units'
import { buildDefectLabelsByCode, resolveTagLabel } from '@/utils/defectLabels'
import {
  DEFAULT_BOOL_LABELS, badgeFor, familyGroups, filterGroups, groupColumns, pickableColumns,
} from '@/utils/columnKinds'
import {
  VIZ_TYPE_META, PARAM_SCHEMA, POLL_INTERVAL_OPTIONS, CONNECTORS,
  defaultOptions, toNullableNumber, legacyBinding, buildPanelPayload,
} from './panelPayload'
import ParamFields from './ParamFields'
import styles from './PanelEditorDialog.module.css'

// `icon` (a string key on VIZ_TYPE_META, panelPayload.js) -> the actual
// @mui/icons-material component. Kept out of panelPayload.js so that pure
// logic module stays JSX-free; per-path imports only (no barrel import).
const VIZ_ICONS = {
  timeseries: ShowChartOutlinedIcon,
  bar: BarChartOutlinedIcon,
  stat: SpeedOutlinedIcon,
  gauge: ExploreOutlinedIcon,
  bargauge: SortOutlinedIcon,
  histogram: EqualizerOutlinedIcon,
  table: TableChartOutlinedIcon,
  pie: PieChartOutlinedIcon,
  heatmap: GridOnOutlinedIcon,
  scatter: ScatterPlotOutlinedIcon,
  statetimeline: ViewTimelineOutlinedIcon,
  candlestick: CandlestickChartOutlinedIcon,
}

// The shape a picker holds before its first answer, or after one that failed.
// Every list the dialog reads must be present, or a `.includes` on the clamp
// path throws instead of clamping.
const EMPTY_COLS = {
  value_columns: [], bool_columns: [], ts_columns: [], filter_columns: [], column_types: {},
}

// What may be bound as a panel's value. Numeric first — it is what a tile
// usually means — with flags offered beside it, drawn as a 0/1 step line.
// Arrays and text are absent on purpose: nothing on this page can draw either.
const VALUE_KINDS = ['value_columns', 'bool_columns']

// Options that only mean something against a measurement. Hidden -- not
// cleared -- when every bound column is a flag: a stored warn on a panel
// someone later re-points at a real reading should still be there.
const BOOL_HIDDEN_PARAMS = new Set(['warn', 'crit', 'decimals'])

function blankValues() {
  return {
    title: '',
    datasource_id: null,
    table_name: null,
    metric: null,
    value_cols: [],
    units: {},
    gaugeSeries: {},
    boolLabels: {},
    filter_col: null,
    filters: [],
    ts_col: null,
    mathExpr: '',
    conditions: [],
    window_minutes: 15,
    chart_type: 'timeseries',
    options: defaultOptions('timeseries'),
    poll_interval_seconds: 5,
  }
}

/**
 * PanelEditorDialog — the Live panel create/edit form (Grafana-style data
 * binding + visualization picker + per-type options + alert conditions).
 * Ported from LivePage.vue's editor dialog (script lines 296-585, template
 * lines 1129-1474).
 *
 * Drives its cascading table/column/filter resolution imperatively via
 * react-hook-form's getValues/setValue (mirroring the Vue version's directly-
 * mutated `reactive(form)` object) rather than a fully-declarative Controller
 * tree everywhere — applyBinding() below intentionally sets several fields at
 * once, same as the Vue original, which a purely-Controller-driven form can't
 * express cleanly.
 */
export default function PanelEditorDialog({
  open,
  editingPanel,
  activeDashboardId,
  panelsLength,
  nextLayout,
  datasources,
  onClose,
  onSaved,
}) {
  const {
    control, register, handleSubmit, watch, setValue, getValues, reset,
  } = useForm({ defaultValues: blankValues() })

  const [schemaTables, setSchemaTables] = useState([])
  const [schemaCols, setSchemaCols] = useState(EMPTY_COLS)
  const [filterValues, setFilterValues] = useState([])
  const [saveError, setSaveError] = useState('')
  const [resolving, setResolving] = useState(false)
  const schemaColsCacheRef = useRef(new Map())
  const schemaTablesRef = useRef([])

  const datasourceId = watch('datasource_id')
  const tableName = watch('table_name')
  const filterCol = watch('filter_col')
  const chartType = watch('chart_type')
  const metric = watch('metric')
  const valueCols = watch('value_cols') || []
  const filters = watch('filters') || []
  const mathExpr = watch('mathExpr') || ''
  const conditions = watch('conditions') || []
  const gaugeSeriesMap = watch('gaugeSeries') || {}
  const unitsMap = watch('units') || {}
  const boolLabelsMap = watch('boolLabels') || {}

  const allValueCols = useMemo(() => [metric, ...valueCols].filter(Boolean), [metric, valueCols])
  const conditionSeriesOptions = allValueCols

  const valueGroups = useMemo(
    () => groupColumns(schemaCols, VALUE_KINDS),
    [schemaCols],
  )
  // Same query key Reports, Events, Alarms and the Monitor camera rail use, so
  // this shares one cache entry with them. An unconfigured or errored camera
  // source just yields an empty map, and every column/tag keeps its raw name.
  const camerasQuery = useQuery({
    queryKey: ['camera-link-options'],
    queryFn: fetchCameraLinkOptions,
    staleTime: 60_000,
    retry: false,
  })
  const labelsByCode = useMemo(
    () => buildDefectLabelsByCode(camerasQuery.data?.cameras),
    [camerasQuery.data],
  )
  const labelForColumn = useCallback(
    (name) => resolveTagLabel(name, null, labelsByCode),
    [labelsByCode],
  )
  // Which of the *bound* columns are flags. Saved on the panel so the tile can
  // print a word for a 0/1 without re-reading the catalogue at render time.
  const boolCols = useMemo(
    () => allValueCols.filter((c) => (schemaCols.bool_columns || []).includes(c)),
    [allValueCols, schemaCols],
  )
  // Warn/crit compare a reading against a limit. Against a flag there is no
  // limit to set -- every threshold is either always or never crossed -- so the
  // fields come off rather than sitting there inviting a rule that cannot fire.
  const allBool = boolCols.length > 0 && boolCols.length === allValueCols.length
  const currentSchema = useMemo(
    () => (PARAM_SCHEMA[chartType] || [])
      .filter((f) => !(allBool && BOOL_HIDDEN_PARAMS.has(f.key))),
    [chartType, allBool],
  )
  const dialogTitle = editingPanel ? 'Edit panel' : 'Add panel'

  const loadTablesFor = useCallback(async (dsId) => {
    try {
      const t = await fetchSchemaTables(dsId || undefined)
      schemaTablesRef.current = t
      setSchemaTables(t)
      return t
    } catch (e) {
      schemaTablesRef.current = []
      setSchemaTables([])
      setSaveError(e?.response?.data?.detail || 'Could not load tables from that connection.')
      return []
    }
  }, [])

  // Resolve a binding against the chosen table's columns, clamping each field
  // to a valid value. Shared by the open-effect below and every cascading
  // handler (table / datasource / filter-column change).
  const applyBinding = useCallback(async ({
    table, metric: m, value_cols, filter_col, filters: f, ts_col,
  }, tablesOverride) => {
    const tables = tablesOverride || schemaTablesRef.current
    const exists = tables.some((t) => t.table === table)
    const resolvedTable = exists ? table : (tables[0]?.table ?? null)
    setValue('table_name', resolvedTable)
    if (!resolvedTable) {
      setSchemaCols(EMPTY_COLS)
      setValue('metric', null)
      setValue('value_cols', [])
      setValue('filter_col', null)
      setValue('filters', [])
      setValue('ts_col', null)
      setFilterValues([])
      return
    }
    const dsId = getValues('datasource_id')
    const cacheKey = `${dsId ?? 'app'}::${resolvedTable}`
    let cols = schemaColsCacheRef.current.get(cacheKey)
    if (!cols) {
      try {
        cols = await fetchSchemaColumns(resolvedTable, dsId || undefined)
      } catch {
        cols = EMPTY_COLS
      }
      schemaColsCacheRef.current.set(cacheKey, cols)
    }
    setSchemaCols(cols)
    // Clamped against exactly the list the picker draws, booleans included —
    // clamping against `value_columns` alone would let a boolean metric save
    // and then silently vanish the next time this dialog opened it.
    const pickable = pickableColumns(cols, VALUE_KINDS)
    const newMetric = pickable.includes(m) ? m : (pickable[0] ?? null)
    setValue('metric', newMetric)
    const newValueCols = (value_cols || []).filter((c) => pickable.includes(c) && c !== newMetric)
    setValue('value_cols', newValueCols)
    const newTs = ts_col && cols.ts_columns.includes(ts_col) ? ts_col : (cols.ts_columns[0] ?? null)
    setValue('ts_col', newTs)
    const newFilterCol = filter_col && cols.filter_columns.includes(filter_col) ? filter_col : null
    setValue('filter_col', newFilterCol)

    let fv = []
    if (newFilterCol) {
      try {
        fv = await fetchSchemaValues(resolvedTable, newFilterCol, 500, dsId || undefined)
      } catch {
        fv = []
      }
    }
    setFilterValues(fv)
    let newFilters = []
    if (newFilterCol) {
      const keep = (f || []).filter((v) => fv.includes(v))
      newFilters = keep.length ? keep : (fv[0] != null ? [fv[0]] : [])
    }
    setValue('filters', newFilters)

    // Drop unit/gauge declarations whose series no longer exist.
    const liveKeys = new Set([newMetric, ...newValueCols, ...newFilters].filter(Boolean))
    const curUnits = getValues('units') || {}
    const nextUnits = {}
    for (const k of Object.keys(curUnits)) if (liveKeys.has(k)) nextUnits[k] = curUnits[k]
    setValue('units', nextUnits)
    const curGauge = getValues('gaugeSeries') || {}
    const nextGauge = {}
    for (const k of Object.keys(curGauge)) if (liveKeys.has(k)) nextGauge[k] = curGauge[k]
    setValue('gaugeSeries', nextGauge)
  }, [setValue, getValues])

  // Populate the form when the dialog opens (create or edit mode).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSaveError('')
    setResolving(true)
    ;(async () => {
      if (editingPanel) {
        const panel = editingPanel
        const {
          // eslint-disable-next-line no-unused-vars
          tags: _t, filters: _f, value_cols: _v, mathExpr: _m, units: _u, gaugeSeries: _g, conditions: _c, layout: _l,
          boolCols: _bc, boolLabels: _bl,
          ...vizOpts
        } = panel.options || {}
        const chart_type = panel.chart_type === 'line' ? 'timeseries' : panel.chart_type
        reset({
          ...blankValues(),
          title: panel.title,
          datasource_id: panel.datasource_id ?? null,
          units: { ...(panel.options?.units || {}) },
          gaugeSeries: { ...(panel.options?.gaugeSeries || {}) },
          boolLabels: { ...(panel.options?.boolLabels || {}) },
          mathExpr: panel.options?.mathExpr || '',
          conditions: JSON.parse(JSON.stringify(panel.options?.conditions || [])),
          window_minutes: panel.window_minutes,
          chart_type,
          options: { ...defaultOptions(chart_type), ...vizOpts },
          poll_interval_seconds: panel.poll_interval_seconds || 5,
        })
        const tables = await loadTablesFor(panel.datasource_id ?? null)
        if (cancelled) return
        const binding = panel.source === 'table'
          ? {
            table: panel.table_name,
            metric: panel.metric,
            value_cols: Array.isArray(panel.options?.value_cols) ? [...panel.options.value_cols] : [],
            filter_col: panel.filter_col,
            filters: panel.options?.filters?.length ? [...panel.options.filters] : [],
            ts_col: panel.ts_col,
          }
          : (legacyBinding(panel) || {
            table: null, metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null,
          })
        await applyBinding(binding, tables)
      } else {
        reset(blankValues())
        const tables = await loadTablesFor(null)
        if (cancelled) return
        await applyBinding({
          table: tables[0]?.table ?? null, metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null,
        }, tables)
      }
      if (!cancelled) setResolving(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingPanel])

  async function onDatasourceChange(e) {
    const dsId = e.target.value === '' ? null : e.target.value
    setValue('datasource_id', dsId)
    const tables = await loadTablesFor(dsId)
    await applyBinding({
      table: tables[0]?.table ?? null, metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null,
    }, tables)
  }

  async function onTableChange(table) {
    await applyBinding({ table, metric: null, value_cols: [], filter_col: null, filters: [], ts_col: null })
  }

  async function onFilterColChange(col) {
    setValue('filter_col', col || null)
    let fv = []
    if (col && tableName) {
      try {
        fv = await fetchSchemaValues(tableName, col, 500, datasourceId || undefined)
      } catch {
        fv = []
      }
    }
    setFilterValues(fv)
    setValue('filters', col && fv[0] != null ? [fv[0]] : [])
  }

  function onVizTypeChange(type) {
    setValue('chart_type', type)
    setValue('options', defaultOptions(type))
  }

  // --- value-column management -----------------------------------------
  function firstUnusedValueCol() {
    const used = new Set(allValueCols)
    return pickableColumns(schemaCols, VALUE_KINDS).find((c) => !used.has(c)) ?? null
  }
  function addValueCol() {
    const c = firstUnusedValueCol()
    if (c) setValue('value_cols', [...valueCols, c])
  }
  function updateValueCol(i, val) {
    const cols = [...valueCols]
    cols[i] = val
    setValue('value_cols', cols)
  }
  function removeValueCol(i) {
    const cols = [...valueCols]
    const col = cols[i]
    cols.splice(i, 1)
    setValue('value_cols', cols)
    const stillUsed = new Set([metric, ...cols].filter(Boolean))
    if (col && !stillUsed.has(col)) setUnit(col, null)
  }
  // A flag reads 0 or 1. A dial still scaled 0-100 would pin the needle at
  // the floor forever and look exactly like a dead signal, so picking one
  // rescales the tile to the range it actually reports.
  function onMetricChange(col) {
    setValue('metric', col)
    if (!(schemaCols.bool_columns || []).includes(col)) return
    const opts = getValues('options') || {}
    if ('min' in opts) setValue('options.min', 0)
    if ('max' in opts) setValue('options.max', 1)
    if ('decimals' in opts) setValue('options.decimals', 0)
  }

  function setBoolLabel(col, slot, text) {
    const cur = boolLabelsMap[col] || DEFAULT_BOOL_LABELS
    const next = [...cur]
    next[slot] = text
    setValue('boolLabels', { ...boolLabelsMap, [col]: next })
  }
  function setUnit(key, val) {
    if (!key) return
    const u = { ...unitsMap }
    if (val) u[key] = val
    else delete u[key]
    setValue('units', u)
  }

  // --- filter-value management -------------------------------------------
  function firstUnusedFilter() {
    const used = new Set(filters)
    return filterValues.find((v) => !used.has(v)) ?? filterValues[0] ?? null
  }
  function addFilter() {
    const v = firstUnusedFilter()
    if (v != null) setValue('filters', [...filters, v])
  }
  function updateFilter(i, val) {
    const arr = [...filters]
    arr[i] = val
    setValue('filters', arr)
  }
  function removeFilter(i) {
    const arr = [...filters]
    const fv = arr[i]
    arr.splice(i, 1)
    setValue('filters', arr)
    if (fv != null && !arr.includes(fv)) {
      setUnit(fv, null)
      setGaugeSeriesField(fv, null, null) // drop the whole entry below
    }
  }

  // --- gauge per-series overrides ----------------------------------------
  const gaugeSeriesKeys = chartType === 'gauge'
    ? (filterCol ? filters.filter(Boolean) : allValueCols)
    : []

  function setGaugeSeriesField(key, field, value) {
    const g = { ...gaugeSeriesMap }
    if (field === null) { delete g[key]; setValue('gaugeSeries', g); return }
    const entry = { ...(g[key] || {}) }
    const nv = toNullableNumber(value)
    if (nv == null) delete entry[field]
    else entry[field] = nv
    if (Object.keys(entry).length) g[key] = entry
    else delete g[key]
    setValue('gaugeSeries', g)
  }
  function hasGaugeOverride(key) {
    return !!gaugeSeriesMap[key] && Object.keys(gaugeSeriesMap[key]).length > 0
  }

  // --- alert-condition builder --------------------------------------------
  function addCondition() {
    const first = conditionSeriesOptions[0] || null
    setValue('conditions', [...conditions, { rows: [{ lhs: first, op: '>', rhsType: 'value', rhs: 0 }] }])
  }
  function removeCondition(ci) {
    const arr = [...conditions]
    arr.splice(ci, 1)
    setValue('conditions', arr)
  }
  function addRow(ci, connector) {
    const arr = conditions.map((c, i) => (i === ci ? { rows: [...c.rows] } : c))
    const first = conditionSeriesOptions[0] || null
    arr[ci].rows.push({ lhs: first, op: '>', rhsType: 'value', rhs: 0, connector })
    setValue('conditions', arr)
  }
  function removeRow(ci, ri) {
    const arr = conditions.map((c, i) => (i === ci ? { rows: [...c.rows] } : c))
    arr[ci].rows.splice(ri, 1)
    if (!arr[ci].rows.length) arr.splice(ci, 1)
    else if (ri === 0) { const { connector, ...rest } = arr[ci].rows[0]; arr[ci].rows[0] = rest }
    setValue('conditions', arr)
  }
  function updateRow(ci, ri, patch) {
    const arr = conditions.map((c, i) => (i === ci ? { rows: [...c.rows] } : c))
    arr[ci].rows[ri] = { ...arr[ci].rows[ri], ...patch }
    setValue('conditions', arr)
  }
  function onRhsTypeChange(ci, ri, rhsType) {
    updateRow(ci, ri, { rhsType, rhs: rhsType === 'series' ? (conditionSeriesOptions[0] || null) : 0 })
  }

  // --- save ----------------------------------------------------------------
  const createMut = useMutation({ mutationFn: createPanel })
  const updateMut = useMutation({ mutationFn: ({ id, payload }) => updatePanel(id, payload) })
  const saving = createMut.isPending || updateMut.isPending

  async function onSubmit(values) {
    setSaveError('')
    const result = buildPanelPayload({
      // `boolCols` is derived from the live catalogue rather than typed, so it
      // is not an RHF field -- it joins the form only here, on the way out.
      form: { ...values, boolCols }, editingPanel, activeDashboardId, panelsLength, nextLayout,
    })
    if (!result.ok) { setSaveError(result.error); return }
    try {
      if (editingPanel) {
        const updated = await updateMut.mutateAsync({ id: editingPanel.id, payload: result.payload })
        onSaved(updated, false)
      } else {
        const created = await createMut.mutateAsync(result.payload)
        onSaved(created, true)
      }
      onClose()
    } catch (e) {
      setSaveError(e?.response?.data?.detail || 'Failed to save panel.')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>{dialogTitle}</DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)}>
        <DialogContent className={styles.content}>
          <div className={styles.grid}>
            {/* ── LEFT: data binding ── */}
            <div className={styles.left}>
              <TextField label="Title" placeholder="e.g. Boiler pressure" fullWidth size="small" {...register('title')} />

              <FormControl fullWidth size="small">
                <InputLabel id="pde-datasource-label">Connection</InputLabel>
                <Select
                  labelId="pde-datasource-label"
                  label="Connection"
                  value={datasourceId ?? ''}
                  onChange={onDatasourceChange}
                >
                  <MenuItem value="">Default (app database)</MenuItem>
                  {(datasources || []).map((ds) => (
                    <MenuItem key={ds.id} value={ds.id}>{`${ds.name} — ${ds.host}:${ds.port}/${ds.database}`}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth size="small">
                <InputLabel id="pde-table-label">Table</InputLabel>
                <Select
                  labelId="pde-table-label"
                  label="Table"
                  value={tableName ?? ''}
                  onChange={(e) => onTableChange(e.target.value)}
                >
                  {schemaTables.map((t) => (
                    <MenuItem key={t.table} value={t.table}>{t.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Value column</span>
                <div className={styles.taglist}>
                  <div className={styles.taglistRow}>
                    <span className={styles.swatch} style={{ background: colorAt(0) }} />
                    <ColumnSelect
                      className={styles.taglistSelect}
                      value={metric}
                      onChange={onMetricChange}
                      groups={valueGroups}
                      labelFor={labelForColumn}
                      searchable
                    />
                    {!filterCol && (
                      <UnitPicker className={styles.taglistUnit} value={unitsMap[metric] || ''} onChange={(v) => setUnit(metric, v)} />
                    )}
                    <span className={styles.removePlaceholder} />
                  </div>
                  {valueCols.map((c, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <div key={i} className={styles.taglistRow}>
                      <span className={styles.swatch} style={{ background: colorAt(i + 1) }} />
                      <ColumnSelect
                        className={styles.taglistSelect}
                        value={c}
                        onChange={(v) => updateValueCol(i, v)}
                        groups={valueGroups}
                        labelFor={labelForColumn}
                        searchable
                      />
                      {!filterCol && (
                        <UnitPicker className={styles.taglistUnit} value={unitsMap[c] || ''} onChange={(v) => setUnit(c, v)} />
                      )}
                      <IconButton size="small" title="Remove value" onClick={() => removeValueCol(i)}>
                        <CloseIcon fontSize="inherit" />
                      </IconButton>
                    </div>
                  ))}
                  <Button size="small" onClick={addValueCol}>+ Value</Button>
                </div>
              </div>

              {boolCols.length > 0 && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>On/off labels</span>
                  {/* A flag plots as 0 and 1, which is what a chart needs and
                      what nobody wants to read on a stat tile. These are the
                      two words that stand in for it wherever a single value is
                      printed -- the number itself is what still gets drawn. */}
                  {boolCols.map((c) => (
                    <div key={c} className={styles.taglistRow}>
                      <span className={styles.boolColName}>{c}</span>
                      <TextField
                        size="small"
                        label="Off (0)"
                        value={(boolLabelsMap[c] || DEFAULT_BOOL_LABELS)[0]}
                        onChange={(e) => setBoolLabel(c, 0, e.target.value)}
                      />
                      <TextField
                        size="small"
                        label="On (1)"
                        value={(boolLabelsMap[c] || DEFAULT_BOOL_LABELS)[1]}
                        onChange={(e) => setBoolLabel(c, 1, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.pair}>
                <FormControl fullWidth size="small">
                  <InputLabel id="pde-ts-label">Timestamp</InputLabel>
                  <Select
                    labelId="pde-ts-label"
                    label="Timestamp"
                    value={watch('ts_col') ?? ''}
                    onChange={(e) => setValue('ts_col', e.target.value || null)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {(schemaCols.ts_columns || []).map((c) => (
                      <MenuItem key={c} value={c} className={styles.colOption}>
                        <span className={styles.colName}>{c}</span>
                        <span className={styles.colBadge}>{badgeFor(schemaCols, c)}</span>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth size="small">
                  <InputLabel id="pde-filtercol-label">Filter column</InputLabel>
                  <Select
                    labelId="pde-filtercol-label"
                    label="Filter column"
                    value={filterCol ?? ''}
                    onChange={(e) => onFilterColChange(e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {(schemaCols.filter_columns || []).map((c) => (
                      <MenuItem key={c} value={c} className={styles.colOption}>
                        <span className={styles.colName}>{c}</span>
                        <span className={styles.colBadge}>{badgeFor(schemaCols, c)}</span>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>

              {filterCol && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Series values</span>
                  <div className={styles.taglist}>
                    {filters.map((v, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={i} className={styles.taglistRow}>
                        <span className={styles.swatch} style={{ background: colorAt(i) }} />
                        <ColumnSelect
                          className={styles.taglistSelect}
                          value={v}
                          onChange={(nv) => updateFilter(i, nv)}
                          options={filterValues}
                          labelFor={labelForColumn}
                          searchable
                        />
                        <UnitPicker className={styles.taglistUnit} value={unitsMap[v] || ''} onChange={(nv) => setUnit(v, nv)} />
                        <IconButton size="small" disabled={filters.length <= 1} title="Remove series" onClick={() => removeFilter(i)}>
                          <CloseIcon fontSize="inherit" />
                        </IconButton>
                      </div>
                    ))}
                    <Button size="small" onClick={addFilter}>+ Add series</Button>
                  </div>
                </div>
              )}

              {chartType === 'gauge' && gaugeSeriesKeys.length > 1 && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Per-series gauge options</span>
                  {gaugeSeriesKeys.map((key, i) => (
                    <Accordion key={key} disableGutters className={styles.accordion}>
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <span className={styles.gaugeHead}>
                          <span className={styles.swatch} style={{ background: colorAt(i) }} />
                          {key}
                          {hasGaugeOverride(key) && <Chip size="small" label="custom" className={styles.badge} />}
                        </span>
                      </AccordionSummary>
                      <AccordionDetails>
                        <div className={styles.gaugeGrid}>
                          {['min', 'max', 'decimals', 'warn', 'crit'].map((field) => (
                            <TextField
                              key={field}
                              size="small"
                              type="number"
                              label={field === 'warn' ? 'Warning ≥' : field === 'crit' ? 'Critical ≥' : field[0].toUpperCase() + field.slice(1)}
                              placeholder="default"
                              value={gaugeSeriesMap[key]?.[field] ?? ''}
                              onChange={(e) => setGaugeSeriesField(key, field, e.target.value)}
                            />
                          ))}
                        </div>
                      </AccordionDetails>
                    </Accordion>
                  ))}
                </div>
              )}

              <Accordion disableGutters className={styles.accordion}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  Expression
                  {mathExpr.trim() && <Chip size="small" label="active" className={styles.badge} />}
                </AccordionSummary>
                <AccordionDetails>
                  <TextField
                    fullWidth
                    size="small"
                    placeholder="e.g. a * 1.8 + 32, sqrt(a)"
                    {...register('mathExpr')}
                  />
                  <p className={styles.hint}>Variable: <code>a</code> — <code>abs sqrt pow min max floor ceil round</code></p>
                </AccordionDetails>
              </Accordion>

              <Accordion disableGutters className={styles.accordion}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  Alert conditions
                  {conditions.length > 0 && <Chip size="small" label={conditions.length} className={styles.badge} />}
                </AccordionSummary>
                <AccordionDetails>
                  {conditions.map((cond, ci) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <div key={ci} className={styles.condBlock}>
                      {cond.rows.map((row, ri) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <div key={ri} className={styles.condRow}>
                          {ri > 0 ? (
                            <FormControl size="small" className={styles.condConn}>
                              <Select value={row.connector || 'AND'} onChange={(e) => updateRow(ci, ri, { connector: e.target.value })}>
                                {CONNECTORS.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                              </Select>
                            </FormControl>
                          ) : <span className={styles.condWhen}>When</span>}

                          <FormControl size="small" className={styles.condSeries}>
                            <Select value={row.lhs ?? ''} displayEmpty onChange={(e) => updateRow(ci, ri, { lhs: e.target.value })}>
                              <MenuItem value="" disabled>series</MenuItem>
                              {conditionSeriesOptions.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                            </Select>
                          </FormControl>

                          <FormControl size="small" className={styles.condOp}>
                            <Select value={row.op} onChange={(e) => updateRow(ci, ri, { op: e.target.value })}>
                              {COMPARATOR_OPS.map((op) => <MenuItem key={op} value={op}>{op}</MenuItem>)}
                            </Select>
                          </FormControl>

                          <FormControl size="small" className={styles.condRhstype}>
                            <Select value={row.rhsType} onChange={(e) => onRhsTypeChange(ci, ri, e.target.value)}>
                              <MenuItem value="value">value</MenuItem>
                              <MenuItem value="series">series</MenuItem>
                            </Select>
                          </FormControl>

                          {row.rhsType !== 'series' ? (
                            <TextField
                              size="small"
                              type="number"
                              className={styles.condRhs}
                              value={row.rhs ?? ''}
                              onChange={(e) => updateRow(ci, ri, { rhs: e.target.value === '' ? 0 : Number(e.target.value) })}
                            />
                          ) : (
                            <FormControl size="small" className={styles.condRhs}>
                              <Select value={row.rhs ?? ''} displayEmpty onChange={(e) => updateRow(ci, ri, { rhs: e.target.value })}>
                                <MenuItem value="" disabled>series</MenuItem>
                                {conditionSeriesOptions.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                              </Select>
                            </FormControl>
                          )}

                          <IconButton size="small" title="Remove row" onClick={() => removeRow(ci, ri)}>
                            <CloseIcon fontSize="inherit" />
                          </IconButton>
                        </div>
                      ))}
                      <div className={styles.condActions}>
                        <Button size="small" onClick={() => addRow(ci, 'AND')}>+ AND</Button>
                        <Button size="small" onClick={() => addRow(ci, 'OR')}>+ OR</Button>
                        <Button size="small" color="error" onClick={() => removeCondition(ci)}>Remove condition</Button>
                      </div>
                    </div>
                  ))}
                  <Button size="small" onClick={addCondition}>+ Add condition</Button>
                  <p className={styles.hint}>
                    Pick a series, a comparator and a value (or another series). The pill shows <code>series ALERTS</code> when true.
                  </p>
                </AccordionDetails>
              </Accordion>
            </div>

            {/* ── RIGHT: visualization ── */}
            <div className={styles.right}>
              <div className={styles.sectionLabel}>Visualization</div>
              <div className={styles.vizpicker}>
                {VIZ_TYPE_META.map((v) => {
                  const Icon = VIZ_ICONS[v.icon]
                  return (
                    <button
                      key={v.value}
                      type="button"
                      className={`${styles.vizItem} ${chartType === v.value ? styles.vizItemActive : ''}`}
                      title={v.hint}
                      onClick={() => onVizTypeChange(v.value)}
                    >
                      <Icon fontSize="small" className={styles.vizIcon} />
                      <span className={styles.vizLabel}>{v.label}</span>
                    </button>
                  )
                })}
              </div>

              <div className={styles.submenu}>
                <div className={styles.submenuHead}>
                  {VIZ_TYPE_META.find((v) => v.value === chartType)?.label} options
                </div>
                <ParamFields schema={currentSchema} control={control} />
              </div>

              <div className={styles.pair}>
                <TextField
                  size="small"
                  type="number"
                  label="Window (min)"
                  slotProps={{ htmlInput: { min: 1, max: 1440 } }}
                  {...register('window_minutes', { valueAsNumber: true })}
                />
                <FormControl fullWidth size="small">
                  <InputLabel id="pde-poll-label">Poll interval</InputLabel>
                  <Select
                    labelId="pde-poll-label"
                    label="Poll interval"
                    value={watch('poll_interval_seconds')}
                    onChange={(e) => setValue('poll_interval_seconds', Number(e.target.value))}
                  >
                    {POLL_INTERVAL_OPTIONS.map((it) => (
                      <MenuItem key={it.value} value={it.value}>{it.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>
            </div>
          </div>

          {saveError && <Alert severity="error">{saveError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" loading={saving || resolving}>Save</Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * A column dropdown that says what kind of column each option is.
 *
 * Two things it does that a bare <Select> did not. It groups by kind and prints
 * a type badge, because `enabled` and `enabled_count` are indistinguishable by
 * name and picking the wrong one is only discovered after the tile draws. And
 * it filters, because a plant historian's table runs to dozens of columns and a
 * device list is capped at five hundred -- a flat menu that long is a scroll,
 * not a choice.
 *
 * `options` may be a flat array of strings (device values, which have no kind)
 * or pre-grouped column options; both render through the same filter.
 *
 * `labelFor` swaps a raw name for a human label where one is configured (a
 * camera's `defect_n` slot, via `resolveTagLabel`) — the bound value stays the
 * raw name in every case, only what is printed changes.
 */
function ColumnSelect({
  value, onChange, groups, options, placeholder = 'Value', className, searchable = false,
  labelFor = (name) => name,
}) {
  const [query, setQuery] = useState('')
  const resolved = groups
    ?? [{ key: '_', label: '', options: (options || []).map((name) => ({ name, badge: '' })) }]
  const total = resolved.reduce((n, g) => n + g.options.length, 0)
  // Below a screenful there is nothing to search for, and an input that appears
  // and disappears as the table changes is worse than one that is never there.
  const withSearch = searchable && total > 8
  const shown = withSearch ? filterGroups(resolved, query, labelFor) : resolved
  const grouped = resolved.length > 1

  return (
    <FormControl size="small" className={className}>
      <Select
        value={value ?? ''}
        displayEmpty
        onChange={(e) => onChange(e.target.value)}
        onClose={() => setQuery('')}
        renderValue={(v) => (v ? labelFor(v) : placeholder)}
      >
        <MenuItem value="" disabled>{placeholder}</MenuItem>
        {withSearch && (
          // Inside a ListSubheader so Select does not treat it as an option, and
          // swallowing keystrokes so Select's own typeahead does not steal them
          // and jump the highlight while someone is typing a filter.
          <ListSubheader className={styles.colSearch}>
            <TextField
              size="small"
              fullWidth
              autoFocus
              placeholder="Filter..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
            />
          </ListSubheader>
        )}
        {shown.flatMap((g) => {
          const families = familyGroups(g.options)
          // A single '' bucket means nothing grouped by name within this kind —
          // render flat, exactly as before family-detection existed.
          const nameGrouped = families.length > 1 || families[0]?.key
          const option = (o) => (
            <MenuItem key={`${g.key}:${o.name}`} value={o.name} className={styles.colOption}>
              <span className={styles.colName}>{labelFor(o.name)}</span>
              {o.badge && <span className={styles.colBadge}>{o.badge}</span>}
            </MenuItem>
          )
          return [
            ...(grouped && g.label ? [<ListSubheader key={`h:${g.key}`}>{g.label}</ListSubheader>] : []),
            ...(nameGrouped
              ? families.flatMap((fam) => [
                ...(fam.key
                  ? [<ListSubheader key={`f:${g.key}:${fam.key}`} className={styles.colFamilyHeader}>{fam.key}</ListSubheader>]
                  : []),
                ...fam.options.map(option),
              ])
              : g.options.map(option)),
          ]
        })}
        {withSearch && shown.length === 0 && (
          <MenuItem disabled>No match for &quot;{query}&quot;</MenuItem>
        )}
      </Select>
    </FormControl>
  )
}

// Grouped unit dropdown shared by every value-column / filter-value row.
function UnitPicker({ value, onChange, className }) {
  return (
    <FormControl size="small" className={className}>
      <Select value={value || ''} displayEmpty onChange={(e) => onChange(e.target.value || null)}>
        <MenuItem value="">Unit</MenuItem>
        {UNIT_GROUPS.map((g) => [
          <ListSubheader key={g.category}>{g.category}</ListSubheader>,
          ...g.units.map((u) => <MenuItem key={u.value} value={u.value}>{u.label}</MenuItem>),
        ])}
      </Select>
    </FormControl>
  )
}
