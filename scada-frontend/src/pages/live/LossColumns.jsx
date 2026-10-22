import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import MenuItem from '@mui/material/MenuItem'
import { useTranslation } from '@/i18n'
import { fetchSchemaValues } from '@/api/schema'
import { columnChoices, filterChoices, picksArray, whyNotCounted } from './kpiColumns'
import styles from './KpiInspector.module.css'

/**
 * LossColumns — the Loss meter's own binding: which columns count as rejected
 * pieces, and which rows count. Every column of the table is listed; the ones a
 * count cannot read are shown greyed with the reason, so a missing column is
 * never a mystery. Left empty, a table of per-machine columns
 * (CAM001-13-defect_1 …) is still read automatically.
 */
export default function LossColumns({ draft, columns, summary, setKpi }) {
  const tr = useTranslation()
  const kpi = draft.kpi
  const choices = useMemo(() => columnChoices(columns), [columns])
  const rowPickers = useMemo(() => filterChoices(columns), [columns])
  const picked = kpi.defect_cols
  const byName = useMemo(() => new Map(choices.map((c) => [c.name, c])), [choices])

  const valuesQuery = useQuery({
    queryKey: ['schema-values', draft.table_name, kpi.filter_col, draft.datasource_id ?? null],
    queryFn: () => fetchSchemaValues(draft.table_name, kpi.filter_col, 500, draft.datasource_id ?? null),
    enabled: !!draft.table_name && !!kpi.filter_col,
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

  const auto = picked == null
  const machines = summary?.scope !== 'columns' ? summary?.families?.length : 0
  const helper = !draft.table_name ? ''
    : auto
      ? (machines
        ? tr('Reading the machine columns automatically ({n} machines). Pick columns to count something else.', { n: machines })
        : tr('This table has no per-machine columns. Pick the columns that count rejected pieces.'))
      : tr('Each row stamped in the period adds these columns up.')

  return (
    <>
      <Autocomplete
        multiple
        size="small"
        disableCloseOnSelect
        disabled={!draft.table_name}
        options={choices}
        value={(picked || []).map((n) => byName.get(n) || { name: n, badge: '', group: 'Other', countable: false })}
        groupBy={(c) => tr(c.group)}
        getOptionLabel={(c) => c.name}
        isOptionEqualToValue={(a, b) => a.name === b.name}
        getOptionDisabled={(c) => !c.countable}
        onChange={(_, next) => setKpi(next.length
          ? { defect_cols: next.map((c) => c.name), mode: 'defects' }
          : { defect_cols: null })}
        renderOption={(props, c) => {
          const { key, ...rest } = props
          return (
            <li key={key} {...rest}>
              <span className={styles.pick}>
                <span className={styles.pick__name}>{c.name}</span>
                <span className={styles.pick__badge}>{c.countable ? c.badge : tr(whyNotCounted(c))}</span>
              </span>
            </li>
          )
        }}
        renderInput={(params) => (
          <TextField {...params} label={tr('Columns to count')}
            placeholder={auto ? tr('Automatic') : ''} helperText={helper} />
        )}
      />

      {picksArray(choices, picked) && (
        <TextField select size="small" label={tr('Array columns count')} value={kpi.array_mode || 'sum'}
          onChange={(e) => setKpi({ array_mode: e.target.value })}
          helperText={kpi.array_mode === 'first'
            ? tr('Only the first value of each array (a newest-first series).')
            : tr('Every value in each array, added up (a tally per defect type).')}>
          <MenuItem value="sum">{tr('Sum of all values')}</MenuItem>
          <MenuItem value="first">{tr('First value only')}</MenuItem>
        </TextField>
      )}

      <div className={styles.row}>
        <TextField select size="small" label={tr('Only rows where')} value={kpi.filter_col ?? ''}
          disabled={!draft.table_name || rowPickers.length === 0}
          onChange={(e) => setKpi(e.target.value
            ? { filter_col: e.target.value, filter_val: null }
            : { filter_col: null, filter_val: null })}>
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
    </>
  )
}
