import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Drawer from '@mui/material/Drawer'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Alert from '@mui/material/Alert'
import IconButton from '@mui/material/IconButton'
import CloseIcon from '@mui/icons-material/Close'
import { useTranslation } from '@/i18n'
import { apiErrorMessage } from '@/api/client'
import { fetchSchemaTables, fetchSchemaColumns } from '@/api/schema'
import { fetchTagLocations } from '@/api/tags'
import { useKpiSummary } from '@/components/live/useKpiSummary'
import { fmtPieces } from '@/components/live/kpiView'
import { workingHoursFrom } from './kpiPayload'
import styles from './KpiInspector.module.css'

const WEEKDAYS = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun'],
]

/** A number field that keeps '' while typing and hands back null for blank. */
function NumberField({ label, value, onChange, nullable = false, scale = 1, helperText, ...rest }) {
  const [text, setText] = useState(value == null ? '' : String(+(value * scale).toFixed(6)))
  useEffect(() => {
    setText(value == null ? '' : String(+(value * scale).toFixed(6)))
  }, [value, scale])
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      helperText={helperText}
      onChange={(e) => {
        setText(e.target.value)
        if (e.target.value === '') { if (nullable) onChange(null); return }
        const n = Number(e.target.value)
        if (Number.isFinite(n)) onChange(n / scale)
      }}
      {...rest}
    />
  )
}

/**
 * KpiInspector — the non-modal side panel that configures one management
 * block. Edits go into a draft the tile previews live (via /kpi/preview);
 * Save writes the panel, Cancel drops the draft. Machines are detected from
 * the table, so the binding here is only connection → table → clock column,
 * plus the suffix rules that pick each machine's speed and defect columns.
 */
export default function KpiInspector({
  panel, draft, onDraft, datasources, saving, error, onSave, onCancel,
}) {
  const tr = useTranslation()
  const open = !!panel && !!draft
  const kpi = draft?.kpi || {}
  const setKpi = (patch) => onDraft({ ...draft, kpi: { ...draft.kpi, ...patch } })

  const tablesQuery = useQuery({
    queryKey: ['schema-tables', draft?.datasource_id ?? null],
    queryFn: () => fetchSchemaTables(draft?.datasource_id ?? null),
    enabled: open,
  })
  const columnsQuery = useQuery({
    queryKey: ['schema-columns', draft?.table_name, draft?.datasource_id ?? null],
    queryFn: () => fetchSchemaColumns(draft.table_name, draft.datasource_id ?? null),
    enabled: open && !!draft?.table_name,
  })
  const locationsQuery = useQuery({
    queryKey: ['tag-locations', draft?.datasource_id ?? null],
    queryFn: () => fetchTagLocations(draft?.datasource_id ?? null),
    enabled: open,
  })
  const summaryQuery = useKpiSummary(panel || { id: 0, chart_type: 'andon' }, { draft: open ? draft : null })
  const summary = summaryQuery.data

  const tsColumns = columnsQuery.data?.datetime_columns?.length
    ? columnsQuery.data.datetime_columns : (columnsQuery.data?.ts_columns || [])
  const locations = useMemo(
    () => [...new Set((locationsQuery.data || []).map((r) => r.location).filter(Boolean))].sort(),
    [locationsQuery.data],
  )

  // Pick the clock column automatically when the table has exactly one.
  useEffect(() => {
    if (!open || !draft.table_name || kpi.ts_col || tsColumns.length !== 1) return
    setKpi({ ts_col: tsColumns[0] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.table_name, tsColumns.join('|')])

  if (!open) return null

  const families = summary?.families || []
  const familyKeys = [...new Set([...families.map((f) => f.key), ...(kpi.exclude_families || [])])].sort()
  const hours = kpi.working_hours
  const setHours = (patch) => {
    const next = { start: '07:00', end: '17:00', days: [1, 2, 3, 4, 5, 6], ...(hours || {}), ...patch }
    setKpi({ working_hours: workingHoursFrom(next.start, next.end, next.days) ?? hours })
  }

  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open={open}
      slotProps={{ paper: { className: styles.paper } }}
    >
      <header className={styles.head}>
        <h2 className={styles.title}>{tr('Block settings')}</h2>
        <IconButton size="small" aria-label={tr('Close')} onClick={onCancel}><CloseIcon fontSize="small" /></IconButton>
      </header>

      <div className={styles.body}>
        <TextField size="small" label={tr('Title')} value={draft.title}
          onChange={(e) => onDraft({ ...draft, title: e.target.value })} />

        <section className={styles.section}>
          <h3 className={styles.section__title}>{tr('Data')}</h3>
          <TextField select size="small" label={tr('Connection')} value={draft.datasource_id ?? ''}
            onChange={(e) => onDraft({ ...draft, datasource_id: e.target.value === '' ? null : Number(e.target.value), table_name: null, kpi: { ...kpi, ts_col: null, location: null } })}>
            <MenuItem value="">{tr('App database')}</MenuItem>
            {(datasources || []).map((ds) => <MenuItem key={ds.id} value={ds.id}>{ds.name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={tr('Table')} value={draft.table_name ?? ''}
            onChange={(e) => onDraft({ ...draft, table_name: e.target.value || null, kpi: { ...kpi, ts_col: null } })}>
            {(tablesQuery.data || []).map((t) => <MenuItem key={t.table} value={t.table}>{t.label || t.table}</MenuItem>)}
          </TextField>
          <TextField select size="small" label={tr('Time column')} value={kpi.ts_col ?? ''} disabled={!draft.table_name}
            onChange={(e) => setKpi({ ts_col: e.target.value || null })}>
            {tsColumns.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </TextField>
          {locations.length > 0 && (
            <TextField select size="small" label={tr('Location')} value={kpi.location ?? ''}
              onChange={(e) => setKpi({ location: e.target.value || null })}>
              <MenuItem value="">{tr('All locations')}</MenuItem>
              {locations.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
            </TextField>
          )}
          <div className={styles.row}>
            <TextField size="small" label={tr('Speed column ends in')} value={kpi.slots?.speed ?? ''}
              onChange={(e) => setKpi({ slots: { ...kpi.slots, speed: e.target.value } })} />
            <TextField size="small" label={tr('Defect columns end in')} value={kpi.slots?.defects ?? ''}
              onChange={(e) => setKpi({ slots: { ...kpi.slots, defects: e.target.value } })} />
          </div>
        </section>

        {familyKeys.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.section__title}>{tr('Machines')}</h3>
            {familyKeys.map((key) => {
              const fam = families.find((f) => f.key === key)
              const excluded = (kpi.exclude_families || []).includes(key)
              const typed = kpi.targets?.[key]
              return (
                <div key={key} className={styles.machine}>
                  <FormControlLabel
                    className={styles.machine__name}
                    control={<Checkbox size="small" checked={!excluded} onChange={(e) => setKpi({
                      exclude_families: e.target.checked
                        ? (kpi.exclude_families || []).filter((k) => k !== key)
                        : [...(kpi.exclude_families || []), key],
                    })} />}
                    label={key}
                  />
                  {!excluded && (
                    <NumberField
                      label={tr('Target /min')}
                      value={typed ?? null}
                      nullable
                      placeholder={fam?.target != null && fam.target_source === 'auto' ? fmtPieces(fam.target) : ''}
                      helperText={typed != null ? tr('set') : fam?.target != null ? tr('auto {v}', { v: fmtPieces(fam.target) }) : tr('not enough history')}
                      onChange={(v) => {
                        const targets = { ...(kpi.targets || {}) }
                        if (v == null) delete targets[key]; else targets[key] = v
                        setKpi({ targets })
                      }}
                    />
                  )}
                </div>
              )
            })}
          </section>
        )}

        <section className={styles.section}>
          <h3 className={styles.section__title}>{tr('Period and money')}</h3>
          <div className={styles.row}>
            <TextField select size="small" label={tr('Period')} value={kpi.period}
              onChange={(e) => setKpi({ period: e.target.value })}>
              <MenuItem value="today">{tr('Today')}</MenuItem>
              <MenuItem value="week">{tr('This week')}</MenuItem>
              <MenuItem value="month">{tr('This month')}</MenuItem>
            </TextField>
            {panel.chart_type === 'lossmeter' && (
              <TextField select size="small" label={tr('Shows')} value={kpi.mode}
                onChange={(e) => setKpi({ mode: e.target.value })}>
                <MenuItem value="defects">{tr('Defect cost')}</MenuItem>
                <MenuItem value="lost">{tr('Production lost')}</MenuItem>
                <MenuItem value="total">{tr('Total loss')}</MenuItem>
              </TextField>
            )}
          </div>
          <FormControlLabel
            control={<Switch size="small" checked={!!kpi.compare} onChange={(e) => setKpi({ compare: e.target.checked })} />}
            label={tr('Compare with the previous period')}
          />
          <NumberField label={tr('฿ per rejected piece')} value={kpi.cost_per_piece} nullable
            helperText={tr('Also values production lost. Only managers and admins see ฿.')}
            onChange={(v) => setKpi({ cost_per_piece: v })} inputProps={{ min: 0 }} />
        </section>

        <section className={styles.section}>
          <h3 className={styles.section__title}>{tr('Stops')}</h3>
          <div className={styles.row}>
            <NumberField label={tr('Run at ≥ % of target')} value={kpi.run_ratio} scale={100}
              onChange={(v) => setKpi({ run_ratio: v })} />
            <NumberField label={tr('Ignore stops under (s)')} value={kpi.min_stop_sec}
              onChange={(v) => setKpi({ min_stop_sec: Math.round(v) })} />
          </div>
          <NumberField label={tr('Stops longer than (min) are not scheduled')} value={kpi.max_loss_stop_min}
            onChange={(v) => setKpi({ max_loss_stop_min: Math.round(v) })} />
          <FormControlLabel
            control={<Switch size="small" checked={!!hours} onChange={(e) => setKpi({
              working_hours: e.target.checked ? workingHoursFrom('07:00', '17:00', [1, 2, 3, 4, 5, 6]) : null,
            })} />}
            label={tr('Working hours (every stop inside them is a loss)')}
          />
          {hours && (
            <>
              <div className={styles.row}>
                <TextField size="small" type="time" label={tr('From')} value={hours.start}
                  onChange={(e) => setHours({ start: e.target.value })} />
                <TextField size="small" type="time" label={tr('To')} value={hours.end}
                  onChange={(e) => setHours({ end: e.target.value })} />
              </div>
              <div className={styles.days}>
                {WEEKDAYS.map(([d, name]) => (
                  <FormControlLabel key={d} className={styles.day}
                    control={<Checkbox size="small" checked={hours.days.includes(d)} onChange={(e) => setHours({
                      days: e.target.checked ? [...hours.days, d] : hours.days.filter((x) => x !== d),
                    })} />}
                    label={tr(name)} />
                ))}
              </div>
            </>
          )}
        </section>

        <section className={styles.section}>
          <h3 className={styles.section__title}>{tr('Data quality')}</h3>
          <div className={styles.row}>
            <NumberField label={tr('Ignore values above')} value={kpi.valid_max}
              onChange={(v) => setKpi({ valid_max: v })} />
            <NumberField label={tr('Sample every (s)')} value={kpi.sample_sec}
              onChange={(v) => setKpi({ sample_sec: v })} />
          </div>
        </section>

        {summaryQuery.error && (
          <Alert severity="warning">{apiErrorMessage(summaryQuery.error, 'Preview failed.')}</Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </div>

      <footer className={styles.foot}>
        <Button onClick={onCancel}>{tr('Cancel')}</Button>
        <Button variant="contained" loading={saving} onClick={onSave}>{tr('Save')}</Button>
      </footer>
    </Drawer>
  )
}
