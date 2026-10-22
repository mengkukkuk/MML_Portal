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
import Checkbox from '@mui/material/Checkbox'
import Tooltip from '@mui/material/Tooltip'
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
import {
  fetchSchemaTables, fetchSchemaColumns, fetchSchemaValues, fetchSchemaLatest,
} from '@/api/schema'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { createPanel, updatePanel } from '@/api/panels'
import { apiErrorMessage } from '@/api/client'
import { colorAt } from '@/utils/seriesPalette'
import { COMPARATOR_OPS, levelOf } from '@/utils/alertConditions'
import { UNIT_GROUPS } from '@/utils/units'
import { buildDefectLabelsByCode, resolveTagLabel } from '@/utils/defectLabels'
import {
  DEFAULT_BOOL_LABELS, badgeFor, familyGroups, filterGroups, groupColumns, pickableColumns,
} from '@/utils/columnKinds'
import {
  VIZ_TYPE_META, PARAM_SCHEMA, POLL_INTERVAL_OPTIONS, CONNECTORS,
  defaultOptions, TEXT_SIZE_KEYS, toNullableNumber, legacyBinding, buildPanelPayload,
} from './panelPayload'
import {
  deriveSeriesSpecs, slotKey, slotsOf, isDefaultSlots, cleanSlots,
} from '@/components/live/seriesModel'
import ParamFields from './ParamFields'
import styles from './PanelEditorDialog.module.css'

// `icon` (a string key on VIZ_TYPE_META, panelPayload.js) -> the actual
// @mui/icons-material component. Kept out of panelPayload.js so that pure
// logic module stays JSX-free; per-path imports only (no barrel import).
export const VIZ_ICONS = {
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
// Numeric-array readings (a value bundled with its setpoint and limits, per
// db.py's _NUMERIC_ARRAY_UDTS) come next: some plant tables carry no scalar
// numeric columns at all, only these. An array column draws slot 0 unless its
// row lists other slots (see ArraySlots) — each listed slot is its own line.
// Text is last: a Stat or Table prints the latest word, and a chart shows it as
// a chip above the plot (seriesModel's `isText`).
const VALUE_KINDS = ['value_columns', 'bool_columns', 'array_value_columns', 'text_columns']
// A gauge setpoint has to be a number: flags are left out.
const SETPOINT_KINDS = ['value_columns', 'array_value_columns']

// Options that only mean something against a measurement. Hidden -- not
// cleared -- when every bound column is a flag or a word: a stored warn on a panel
// someone later re-points at a real reading should still be there.
const BOOL_HIDDEN_PARAMS = new Set(['warn', 'crit', 'decimals'])

// The chart types that print a word. Every other type needs at least one number.
const TEXT_FRIENDLY = new Set(['stat', 'table'])

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
    columnLabels: {},
    unsplitCols: [],
    arraySlots: {},
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
  // Chart type a new panel starts as — set when the type was picked in the
  // Live page's block palette.
  initialChartType = null,
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
  const columnLabelsMap = watch('columnLabels') || {}
  const unsplitCols = watch('unsplitCols') || []
  const arraySlotsMap = watch('arraySlots') || {}

  const allValueCols = useMemo(() => [metric, ...valueCols].filter(Boolean), [metric, valueCols])
  // Which of the bound columns are words / arrays, read off the live catalogue.
  const textCols = useMemo(
    () => allValueCols.filter((c) => (schemaCols.text_columns || []).includes(c)),
    [allValueCols, schemaCols],
  )
  const arrayCols = useMemo(
    () => new Set(allValueCols.filter((c) => (schemaCols.array_value_columns || []).includes(c))),
    [allValueCols, schemaCols],
  )
  // "Not split by series" is only a choice once a series column has several
  // value columns to be set apart from.
  const canUnsplit = !!filterCol && allValueCols.length > 1
  // Every line this binding will draw: the single place the editor asks "what
  // are the series called", for units, gauge overrides and conditions alike.
  const editorSpecs = useMemo(() => deriveSeriesSpecs({
    metric,
    valueCols,
    filterCol,
    filters,
    unsplitCols: canUnsplit ? unsplitCols : [],
    arraySlots: arraySlotsMap,
    columnLabels: columnLabelsMap,
    textCols,
  }), [metric, valueCols, filterCol, filters, canUnsplit, unsplitCols, arraySlotsMap, columnLabelsMap, textCols])
  // A condition compares numbers, so words are not offered; a slot is named col[i].
  const conditionSeriesOptions = useMemo(
    () => [...new Set(editorSpecs.filter((sp) => !sp.isText).map((sp) => sp.varName))],
    [editorSpecs],
  )

  const valueGroups = useMemo(
    () => groupColumns(schemaCols, VALUE_KINDS),
    [schemaCols],
  )
  const setpointGroups = useMemo(
    () => groupColumns(schemaCols, SETPOINT_KINDS),
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
  // A saved display name always wins over the defect-code label — both are
  // "call this raw name something else", but a name someone typed on this
  // exact panel is more specific than one inferred from a camera's defect
  // catalogue.
  const labelForColumn = useCallback(
    (name) => columnLabelsMap[name] || resolveTagLabel(name, null, labelsByCode),
    [labelsByCode, columnLabelsMap],
  )
  // Which of the *bound* columns are flags. Saved on the panel so the tile can
  // print a word for a 0/1 without re-reading the catalogue at render time.
  const boolCols = useMemo(
    () => allValueCols.filter((c) => (schemaCols.bool_columns || []).includes(c)),
    [allValueCols, schemaCols],
  )
  // Warn/crit compare a reading against a limit. Against a flag or a word there
  // is no limit to set -- every threshold is either always or never crossed --
  // so the fields come off rather than sitting there inviting a rule that cannot fire.
  const allBool = allValueCols.length > 0
    && boolCols.length + textCols.length === allValueCols.length
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
      setSaveError(apiErrorMessage(e, 'Could not load tables from that connection.'))
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

    // Per-column options survive only for columns still bound (and, for slots,
    // still arrays).
    const bound = new Set([newMetric, ...newValueCols].filter(Boolean))
    const nextUnsplit = (getValues('unsplitCols') || []).filter((c) => bound.has(c))
    setValue('unsplitCols', nextUnsplit)
    const arrayNames = new Set(cols.array_value_columns || [])
    const curSlots = getValues('arraySlots') || {}
    const nextSlots = {}
    for (const k of Object.keys(curSlots)) if (bound.has(k) && arrayNames.has(k)) nextSlots[k] = curSlots[k]
    setValue('arraySlots', nextSlots)

    // Drop unit/gauge declarations whose series no longer exist.
    const liveKeys = new Set([newMetric, ...newValueCols, ...newFilters].filter(Boolean))
    for (const sp of deriveSeriesSpecs({
      metric: newMetric,
      valueCols: newValueCols,
      filterCol: newFilterCol,
      filters: newFilters,
      unsplitCols: newFilterCol ? nextUnsplit : [],
      arraySlots: nextSlots,
    })) liveKeys.add(sp.unitKey)
    const curUnits = getValues('units') || {}
    const nextUnits = {}
    for (const k of Object.keys(curUnits)) if (liveKeys.has(k)) nextUnits[k] = curUnits[k]
    setValue('units', nextUnits)
    const curGauge = getValues('gaugeSeries') || {}
    const nextGauge = {}
    for (const k of Object.keys(curGauge)) if (liveKeys.has(k)) nextGauge[k] = curGauge[k]
    setValue('gaugeSeries', nextGauge)
    // Display names share units' key space (column when unfiltered, filter
    // value when filtered) -- same liveKeys prune.
    const curLabels = getValues('columnLabels') || {}
    const nextLabels = {}
    for (const k of Object.keys(curLabels)) if (liveKeys.has(k)) nextLabels[k] = curLabels[k]
    setValue('columnLabels', nextLabels)
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
          boolCols: _bc, boolLabels: _bl, columnLabels: _cl,
          unsplitCols: _uc, arraySlots: _as, textCols: _tc,
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
          columnLabels: { ...(panel.options?.columnLabels || {}) },
          unsplitCols: [...(panel.options?.unsplitCols || [])],
          arraySlots: JSON.parse(JSON.stringify(panel.options?.arraySlots || {})),
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
        const chart_type = initialChartType || 'timeseries'
        reset({ ...blankValues(), chart_type, options: defaultOptions(chart_type) })
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
  }, [open, editingPanel, initialChartType])

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
    // Text size is a property of the tile, not the chart: keep it across a
    // type switch while every type-specific option resets to its default.
    const prev = getValues('options') || {}
    const kept = {}
    for (const k of TEXT_SIZE_KEYS) if (prev[k] != null) kept[k] = prev[k]
    setValue('chart_type', type)
    setValue('options', { ...defaultOptions(type), ...kept })
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
  // Everything a column carried that is not part of the binding itself: its
  // unit, display name, "not split" flag and array slots (with their units).
  // Called once a column is no longer bound anywhere in the panel.
  function dropColumnState(col, stillBound) {
    if (!col || stillBound.has(col)) return
    setUnit(col, null)
    setColumnLabel(col, null)
    setValue('unsplitCols', (getValues('unsplitCols') || []).filter((c) => c !== col))
    const slots = { ...(getValues('arraySlots') || {}) }
    const units = { ...(getValues('units') || {}) }
    for (const sl of slots[col] || []) delete units[slotKey(col, sl.index)]
    for (const k of Object.keys(units)) if (k.startsWith(`${col}[`)) delete units[k]
    setValue('units', units)
    delete slots[col]
    setValue('arraySlots', slots)
  }
  function updateValueCol(i, val) {
    const cols = [...valueCols]
    const prev = cols[i]
    cols[i] = val
    setValue('value_cols', cols)
    dropColumnState(prev, new Set([metric, ...cols].filter(Boolean)))
  }
  function removeValueCol(i) {
    const cols = [...valueCols]
    const col = cols[i]
    cols.splice(i, 1)
    setValue('value_cols', cols)
    dropColumnState(col, new Set([metric, ...cols].filter(Boolean)))
  }
  function setUnsplit(col, on) {
    const cur = getValues('unsplitCols') || []
    setValue('unsplitCols', on ? [...new Set([...cur, col])] : cur.filter((c) => c !== col))
  }
  // The slot list is saved only when it says something: the default (slot 0,
  // unnamed) is what an absent entry already means.
  function setColumnSlots(col, slots) {
    const next = { ...arraySlotsMap }
    if (isDefaultSlots(slots)) delete next[col]
    else next[col] = cleanSlots(slots)
    setValue('arraySlots', next)
  }
  // A flag reads 0 or 1. A dial still scaled 0-100 would pin the needle at
  // the floor forever and look exactly like a dead signal, so picking one
  // rescales the tile to the range it actually reports.
  function onMetricChange(col) {
    const prev = metric
    setValue('metric', col)
    dropColumnState(prev, new Set([col, ...valueCols].filter(Boolean)))
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
  // Display name -- keyed exactly like units: by column when there is no
  // filter, by filter value (the actual per-series identity) when there is.
  // A `defect_n` column and a `CAM001-13` filter value never collide, so one
  // flat map serves both rows.
  function setColumnLabel(key, text) {
    if (!key) return
    const l = { ...columnLabelsMap }
    if (text) l[key] = text
    else delete l[key]
    setValue('columnLabels', l)
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
      setColumnLabel(fv, null)
      setGaugeSeriesField(fv, null, null) // drop the whole entry below
    }
  }

  // --- gauge per-series overrides ----------------------------------------
  const gaugeSeriesKeys = chartType === 'gauge'
    ? [...new Set(editorSpecs.filter((sp) => !sp.isText).map((sp) => sp.unitKey))]
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
  function setGaugeSeriesCol(key, field, col) {
    const g = { ...gaugeSeriesMap }
    const entry = { ...(g[key] || {}) }
    if (col) entry[field] = col
    else delete entry[field]
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
    setValue('conditions', [...conditions, { level: 'warning', rows: [{ lhs: first, op: '>', rhsType: 'value', rhs: 0 }] }])
  }
  function removeCondition(ci) {
    const arr = [...conditions]
    arr.splice(ci, 1)
    setValue('conditions', arr)
  }
  // Copies keep every condition field (its level), not just the rows.
  function addRow(ci, connector) {
    const arr = conditions.map((c, i) => (i === ci ? { ...c, rows: [...c.rows] } : c))
    const first = conditionSeriesOptions[0] || null
    arr[ci].rows.push({ lhs: first, op: '>', rhsType: 'value', rhs: 0, connector })
    setValue('conditions', arr)
  }
  function removeRow(ci, ri) {
    const arr = conditions.map((c, i) => (i === ci ? { ...c, rows: [...c.rows] } : c))
    arr[ci].rows.splice(ri, 1)
    if (!arr[ci].rows.length) arr.splice(ci, 1)
    else if (ri === 0) { const { connector, ...rest } = arr[ci].rows[0]; arr[ci].rows[0] = rest }
    setValue('conditions', arr)
  }
  function updateRow(ci, ri, patch) {
    const arr = conditions.map((c, i) => (i === ci ? { ...c, rows: [...c.rows] } : c))
    arr[ci].rows[ri] = { ...arr[ci].rows[ri], ...patch }
    setValue('conditions', arr)
  }
  function setConditionLevel(ci, level) {
    setValue('conditions', conditions.map((c, i) => (i === ci ? { ...c, level } : c)))
  }
  function onRhsTypeChange(ci, ri, rhsType) {
    const rhs = rhsType === 'series' ? (conditionSeriesOptions[0] || null)
      : rhsType === 'panel' ? (setpointGroups[0]?.options[0]?.name || null)
        : 0
    updateRow(ci, ri, { rhsType, rhs })
  }

  // --- save ----------------------------------------------------------------
  const createMut = useMutation({ mutationFn: createPanel })
  const updateMut = useMutation({ mutationFn: ({ id, payload }) => updatePanel(id, payload) })
  const saving = createMut.isPending || updateMut.isPending

  async function onSubmit(values) {
    setSaveError('')
    const result = buildPanelPayload({
      // `boolCols` and `textCols` are derived from the live catalogue rather
      // than typed, so they are not RHF fields -- they join the form only here,
      // on the way out.
      form: { ...values, boolCols, textCols }, editingPanel, activeDashboardId, panelsLength, nextLayout,
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
      setSaveError(apiErrorMessage(e, 'Failed to save panel.'))
    }
  }

  // One bound value column: its select, display name, unit, and -- beneath, in
  // the same indented column -- the options that only apply to its kind.
  // `i` is the column's position in the whole bound list (metric first).
  function renderValueRow(col, i) {
    const isMetric = i === 0
    const isText = textCols.includes(col)
    const isArray = arrayCols.has(col)
    const unsplit = canUnsplit && unsplitCols.includes(col)
    const mapped = isArray && !isDefaultSlots(arraySlotsMap[col])
    // Palette steps count drawn series only, matching buildSeriesList.
    const drawnBefore = allValueCols.slice(0, i).filter((x) => !textCols.includes(x)).length
    const onPick = isMetric ? onMetricChange : (v) => updateValueCol(i - 1, v)
    return (
      <div key={`${i}:${col}`} className={styles.taglistGroup}>
        <div className={styles.taglistRow}>
          <span
            className={styles.swatch}
            style={{ background: isText ? 'var(--fg-muted)' : colorAt(drawnBefore) }}
          />
          <ColumnSelect
            className={styles.taglistSelect}
            value={col}
            onChange={onPick}
            groups={valueGroups}
            labelFor={labelForColumn}
            searchable
          />
          {/* The column's own name only ever reaches the legend when
              there is no filter (it *is* the series), or when more
              than one column is charted (it prefixes the filter
              value). A single filtered column's name never shows --
              the field is hidden rather than left to edit nothing. */}
          {(!filterCol || allValueCols.length > 1) && (
            <TextField
              size="small"
              className={styles.taglistName}
              placeholder="Display name"
              value={columnLabelsMap[col] || ''}
              onChange={(e) => setColumnLabel(col, e.target.value)}
            />
          )}
          {/* A unit follows the series value when there is a filter, so the
              column's own picker shows only where the column is the series:
              unfiltered, or drawn once. A word has none, and a mapped array
              keeps one per slot. */}
          {(!filterCol || unsplit) && !isText && !mapped && (
            <UnitPicker className={styles.taglistUnit} value={unitsMap[col] || ''} onChange={(v) => setUnit(col, v)} />
          )}
          {isMetric
            ? <span className={styles.removePlaceholder} />
            : (
              <IconButton size="small" title="Remove value" onClick={() => removeValueCol(i - 1)}>
                <CloseIcon fontSize="inherit" />
              </IconButton>
            )}
        </div>
        {canUnsplit && (
          <Tooltip title="Draw one line for this column instead of one per series value" placement="bottom-start">
            <label className={styles.subOption}>
              <Checkbox
                size="small"
                className={styles.subOptionBox}
                checked={unsplit}
                onChange={(e) => setUnsplit(col, e.target.checked)}
              />
              Don&apos;t split by series
            </label>
          </Tooltip>
        )}
        {isArray && (
          <ArraySlots
            col={col}
            slots={slotsOf(arraySlotsMap, col)}
            onChange={(next) => setColumnSlots(col, next)}
            unitsMap={unitsMap}
            onUnit={setUnit}
            sampleFilter={filterCol && !unsplit ? (filters[0] ?? null) : null}
            filterCol={filterCol}
            table={tableName}
            tsCol={watch('ts_col')}
            datasourceId={datasourceId}
            startColor={drawnBefore}
          />
        )}
      </div>
    )
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
                  {/* The first row is always there, empty or not: it is the picker. */}
                  {[metric ?? null, ...valueCols].map((c, i) => renderValueRow(c, i))}
                  <Button size="small" onClick={addValueCol}>+ Value</Button>
                </div>
                {/* What "Don't split by series" costs, said once beside the
                    list rather than on every row. */}
                {canUnsplit && (
                  <p className={styles.hint}>
                    &quot;Don&apos;t split by series&quot; reads the whole table, not one series value. Best for a
                    column that holds the same value on every row; on a table with one row per
                    device, its history mixes every device.
                  </p>
                )}
                {canUnsplit && allValueCols.every((c) => unsplitCols.includes(c)) && (
                  <p className={styles.hint}>
                    Every column is unsplit, so the series values below have no effect.
                  </p>
                )}
                {textCols.length > 0 && !TEXT_FRIENDLY.has(chartType) && (
                  <p className={styles.hint}>
                    Text shows as a chip above this chart. Stat and Table print it in full.
                  </p>
                )}
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
                        <TextField
                          size="small"
                          className={styles.taglistName}
                          placeholder="Display name"
                          value={columnLabelsMap[v] || ''}
                          onChange={(e) => setColumnLabel(v, e.target.value)}
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
                        <div className={styles.setpointGrid}>
                          {LIMIT_COL_FIELDS.map(({ field, label }) => (
                            <SetpointColumnPicker
                              key={field}
                              label={label}
                              value={gaugeSeriesMap[key]?.[field] || null}
                              placeholder={watch(`options.${field}`) ? 'Panel column' : 'Manual value'}
                              onChange={(col) => setGaugeSeriesCol(key, field, col)}
                              groups={setpointGroups}
                              labelFor={labelForColumn}
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
                              {(setpointGroups.length > 0 || row.rhsType === 'panel') && (
                                <MenuItem value="panel">panel</MenuItem>
                              )}
                            </Select>
                          </FormControl>

                          {row.rhsType === 'panel' ? (
                            <ColumnSelect
                              className={styles.condRhs}
                              value={row.rhs}
                              onChange={(col) => updateRow(ci, ri, { rhs: col })}
                              groups={setpointGroups}
                              labelFor={labelForColumn}
                              placeholder="column"
                              searchable
                            />
                          ) : row.rhsType !== 'series' ? (
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
                        <FormControl size="small" className={styles.condLevel}>
                          <Select
                            value={levelOf(cond)}
                            onChange={(e) => setConditionLevel(ci, e.target.value)}
                            aria-label="Alert level"
                          >
                            <MenuItem value="warning">Warning</MenuItem>
                            <MenuItem value="critical">Critical</MenuItem>
                          </Select>
                        </FormControl>
                        <Button size="small" onClick={() => addRow(ci, 'AND')}>+ AND</Button>
                        <Button size="small" onClick={() => addRow(ci, 'OR')}>+ OR</Button>
                        <Button size="small" color="error" onClick={() => removeCondition(ci)}>Remove condition</Button>
                      </div>
                    </div>
                  ))}
                  <Button size="small" onClick={addCondition}>+ Add condition</Button>
                  <p className={styles.hint}>
                    Pick a series, a comparator and a value, another series, or a table column (<em>panel</em>). Each condition has a level; a gauge shows its own <code>WARNING &gt; 150</code> / <code>CRITICAL &gt; 250</code> pill, other charts list the alerting series above the chart.
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
                {chartType === 'gauge' && (
                  <>
                    <div className={styles.setpointGrid}>
                      {LIMIT_COL_FIELDS.map(({ field, label }) => (
                        <SetpointColumnPicker
                          key={field}
                          label={label}
                          value={watch(`options.${field}`) || null}
                          placeholder="Manual value"
                          onChange={(col) => setValue(`options.${field}`, col || null)}
                          groups={setpointGroups}
                          labelFor={labelForColumn}
                        />
                      ))}
                    </div>
                    <p className={styles.hint}>
                      A setpoint column is read from the same row as each series and overrides the
                      number above. The number is used while the column has no value.
                    </p>
                  </>
                )}
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

const LIMIT_COL_FIELDS = [
  { field: 'warnCol', label: 'Warning setpoint column' },
  { field: 'critCol', label: 'Critical setpoint column' },
]

// Optional column binding for a gauge limit, with a clear button back to the
// manual number. Empty is a real choice here, unlike the value-column picker.
function SetpointColumnPicker({
  label, value, onChange, groups, labelFor, placeholder,
}) {
  return (
    <div className={styles.submenuField}>
      <label className={styles.submenuLabel}>{label}</label>
      <div className={styles.setpointRow}>
        <ColumnSelect
          className={styles.setpointSelect}
          value={value}
          onChange={(v) => onChange(v || null)}
          groups={groups}
          labelFor={labelFor}
          placeholder={placeholder}
          searchable
        />
        <IconButton
          size="small"
          title="Use the manual value"
          aria-label={`Clear ${label.toLowerCase()}`}
          disabled={!value}
          onClick={() => onChange(null)}
        >
          <CloseIcon fontSize="inherit" />
        </IconButton>
      </div>
    </div>
  )
}

/**
 * The slots of one array column, each its own line.
 *
 * An array column carries several readings per row (a measured value with its
 * setpoint and limits). Which slot means what is not in the schema, so each is
 * named here by hand: tick the slots to draw, type what each is called.
 *
 * The slot count is read off one live row so the list starts out complete and
 * each slot shows its current value -- which is also how you tell [2] is the
 * upper limit. When the table has no row yet, or the read fails, the slots
 * already saved are shown and `Add index` takes a number by hand.
 */
function ArraySlots({
  col, slots, onChange, unitsMap, onUnit, sampleFilter, filterCol, table, tsCol, datasourceId,
  startColor,
}) {
  const [draft, setDraft] = useState('')
  const sample = useQuery({
    queryKey: ['pde-array-sample', datasourceId ?? null, table, col, filterCol || null, sampleFilter, tsCol || null],
    queryFn: () => fetchSchemaLatest({
      table, valueCol: col, filterCol, filterVal: sampleFilter, tsCol, datasourceId,
    }),
    enabled: !!table && !!col,
    staleTime: 30_000,
    retry: false,
  })
  const reading = (sample.data?.readings || []).find((r) => Array.isArray(r.value))?.value
  const checked = new Map(slots.map((sl) => [sl.index, sl]))
  const shown = [...new Set([
    ...Array.from({ length: reading?.length || 0 }, (_, i) => i),
    ...slots.map((sl) => sl.index),
    0,
  ])].sort((a, b) => a - b)
  // The palette position of each drawn slot, so the swatch matches its line.
  let drawn = startColor

  function toggle(index, on) {
    if (on) onChange([...slots, { index }])
    else if (slots.length > 1) onChange(slots.filter((sl) => sl.index !== index))
  }
  function rename(index, name) {
    onChange(slots.map((sl) => (sl.index === index ? { ...sl, name } : sl)))
  }
  function addIndex() {
    const n = Number(draft)
    if (!Number.isInteger(n) || n < 0 || checked.has(n)) return
    onChange([...slots, { index: n }])
    setDraft('')
  }

  return (
    <div className={styles.slots} role="group" aria-label={`Slots of ${col}`}>
      <span className={styles.slotsHead}>Plot these positions in the array</span>
      {shown.map((index) => {
        const sl = checked.get(index)
        const on = !!sl
        const color = on ? colorAt(drawn++) : 'transparent'
        const live = reading?.[index]
        return (
          <div key={index} className={`${styles.slotRow} ${on ? '' : styles.slotRowOff}`}>
            <Checkbox
              size="small"
              checked={on}
              disabled={on && slots.length === 1}
              onChange={(e) => toggle(index, e.target.checked)}
              slotProps={{ input: { 'aria-label': `Plot [${index}]` } }}
            />
            <span className={styles.slotSwatch} style={{ background: color }} />
            <span className={styles.slotIndex}>[{index}]</span>
            <span className={styles.slotLive} title="Latest value">
              {live == null ? '\u2014' : String(typeof live === 'number' ? Math.round(live * 1000) / 1000 : live)}
            </span>
            {on && (
              <TextField
                size="small"
                className={styles.slotName}
                placeholder="Name"
                value={sl?.name || ''}
                onChange={(e) => rename(index, e.target.value)}
              />
            )}
            {on && (
              <UnitPicker
                className={styles.taglistUnit}
                value={unitsMap[slotKey(col, index)] || ''}
                onChange={(v) => onUnit(slotKey(col, index), v)}
              />
            )}
          </div>
        )
      })}
      <div className={styles.slotAdd}>
        <TextField
          size="small"
          type="number"
          className={styles.slotAddInput}
          placeholder="Index"
          value={draft}
          slotProps={{ htmlInput: { min: 0, step: 1, 'aria-label': 'Array index to add' } }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIndex() } }}
        />
        <Button size="small" onClick={addIndex} disabled={draft === ''}>Add index</Button>
      </div>
    </div>
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
