import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import MenuItem from '@mui/material/MenuItem'
import { useTranslation } from '@/i18n'
import { fetchSchemaValues } from '@/api/schema'
import { columnChoices, filterChoices, picksArray, usableAs, whyNotUsable } from './kpiColumns'
import styles from './KpiInspector.module.css'

/** Every column of the table in one list; the ones `use` cannot read are greyed with the reason. */
function ColumnPick({ choices, use, multiple = false, value, onChange, label, placeholder, helperText, disabled }) {
  const tr = useTranslation()
  const byName = useMemo(() => new Map(choices.map((c) => [c.name, c])), [choices])
  const asChoice = (n) => byName.get(n) || { name: n, badge: '', group: 'Other' }
  return (
    <Autocomplete
      multiple={multiple}
      size="small"
      disableCloseOnSelect={multiple}
      disabled={disabled}
      options={choices}
      value={multiple ? (value || []).map(asChoice) : (value ? asChoice(value) : null)}
      groupBy={(c) => tr(c.group)}
      getOptionLabel={(c) => c.name}
      isOptionEqualToValue={(a, b) => a.name === b.name}
      getOptionDisabled={(c) => !usableAs(c, use)}
      onChange={(_, next) => onChange(multiple ? next.map((c) => c.name) : (next?.name ?? null))}
      renderOption={(props, c) => {
        const { key, ...rest } = props
        return (
          <li key={key} {...rest}>
            <span className={styles.pick}>
              <span className={styles.pick__name}>{c.name}</span>
              <span className={styles.pick__badge}>{usableAs(c, use) ? c.badge : tr(whyNotUsable(c))}</span>
            </span>
          </li>
        )
      }}
      renderInput={(params) => (
        <TextField {...params} label={label} placeholder={placeholder} helperText={helperText} />
      )}
    />
  )
}

/**
 * BlockColumns — how a management block reads its table, in the table's own
 * columns instead of column-name conventions.
 *
 * Every block can name an Output column (and the Machine column that says whose
 * reading each row is), which makes each machine's run / slow / stop come from
 * that column over time. The Loss meter can also just count defect columns,
 * needing no output at all. Left empty, a table of per-machine columns
 * (CAM001-13-count_1 …) is still read automatically.
 */
export default function BlockColumns({ draft, columns, summary, setKpi, lossmeter }) {
  const tr = useTranslation()
  const kpi = draft.kpi
  const choices = useMemo(() => columnChoices(columns), [columns])
  const rowPickers = useMemo(() => filterChoices(columns), [columns])
  const bound = !!kpi.output_col
  const tally = lossmeter && kpi.defect_cols != null && !bound
  const hasTable = !!draft.table_name

  const valuesQuery = useQuery({
    queryKey: ['schema-values', draft.table_name, kpi.filter_col, draft.datasource_id ?? null],
    queryFn: () => fetchSchemaValues(draft.table_name, kpi.filter_col, 500, draft.datasource_id ?? null),
    enabled: hasTable && !!kpi.filter_col,
  })
  const values = useMemo(
    () => [...new Set([...(valuesQuery.data || []), ...(kpi.filter_val != null ? [kpi.filter_val] : [])])],
    [valuesQuery.data, kpi.filter_val],
  )

  // A row filter needs a value to mean anything: take the first until the user picks one.
  useEffect(() => {
    if (kpi.filter_col && kpi.filter_val == null && valuesQuery.data?.length) {
      setKpi({ filter_val: valuesQuery.data[0] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpi.filter_col, kpi.filter_val, valuesQuery.data])

  const machines = summary?.scope !== 'columns' ? summary?.families?.length : 0
  const outputHelper = !hasTable ? ''
    : bound ? ''
      : tally ? tr('Optional here — add one to measure production lost.')
        : (machines
          ? tr('Reading the machine columns automatically ({n} machines). Pick a column to read another table.', { n: machines })
          : tr('This table has no per-machine columns. Pick the column that counts pieces.'))
  const defectHelper = tally ? tr('Each row stamped in the period adds these columns up.')
    : bound ? tr('Optional. Read in the same unit as the output.')
      : lossmeter && hasTable ? tr('Pick columns to count defects without an output column.') : ''

  return (
    <>
      <ColumnPick choices={choices} use="number" value={kpi.output_col} disabled={!hasTable}
        label={tr('Output column')} placeholder={lossmeter ? tr('None') : tr('Automatic')} helperText={outputHelper}
        onChange={(name) => setKpi(name
          ? { output_col: name }
          : { output_col: null, machine_col: null, value_kind: 'rate', ...(lossmeter ? {} : { defect_cols: null }) })} />

      {bound && (
        <>
          <div className={styles.row}>
            <TextField select size="small" label={tr('Machine column')} value={kpi.machine_col ?? ''}
              onChange={(e) => setKpi({ machine_col: e.target.value || null })}>
              <MenuItem value="">{tr('One machine (whole table)')}</MenuItem>
              {rowPickers.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={tr('Output is')} value={kpi.value_kind || 'rate'}
              onChange={(e) => setKpi({ value_kind: e.target.value })}>
              <MenuItem value="rate">{tr('Pieces per minute')}</MenuItem>
              <MenuItem value="total">{tr('A running total')}</MenuItem>
            </TextField>
          </div>
          <span className={styles.hint}>
            {summary?.families?.length
              ? tr('{n} machines found, one per value of the machine column.', { n: summary.families.length })
              : tr('Every distinct value of the machine column becomes a machine.')}
          </span>
        </>
      )}

      <ColumnPick multiple choices={choices} use={tally ? 'count' : 'number'} value={kpi.defect_cols}
        disabled={!hasTable || (!lossmeter && !bound)}
        label={lossmeter && !bound ? tr('Columns to count') : tr('Defect columns')}
        placeholder={lossmeter && !bound ? tr('Automatic') : ''} helperText={defectHelper}
        onChange={(names) => setKpi(names.length
          ? { defect_cols: names, ...(!bound ? { mode: 'defects' } : {}) }
          : { defect_cols: null })} />

      {tally && picksArray(choices, kpi.defect_cols) && (
        <TextField select size="small" label={tr('Array columns count')} value={kpi.array_mode || 'sum'}
          onChange={(e) => setKpi({ array_mode: e.target.value })}
          helperText={kpi.array_mode === 'first'
            ? tr('Only the first value of each array (a newest-first series).')
            : tr('Every value in each array, added up (a tally per defect type).')}>
          <MenuItem value="sum">{tr('Sum of all values')}</MenuItem>
          <MenuItem value="first">{tr('First value only')}</MenuItem>
        </TextField>
      )}

      {(bound || tally) && (
        <div className={styles.row}>
          <TextField select size="small" label={tr('Only rows where')} value={kpi.filter_col ?? ''}
            disabled={rowPickers.length === 0}
            onChange={(e) => setKpi({ filter_col: e.target.value || null, filter_val: null })}>
            <MenuItem value="">{tr('Any row')}</MenuItem>
            {rowPickers.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={tr('Reads')} value={kpi.filter_val ?? ''}
            disabled={!kpi.filter_col}
            error={!!kpi.filter_col && kpi.filter_val == null}
            onChange={(e) => setKpi({ filter_val: e.target.value })}>
            {values.map((v) => <MenuItem key={v} value={v}>{v === '' ? tr('(blank)') : v}</MenuItem>)}
          </TextField>
        </div>
      )}
    </>
  )
}
