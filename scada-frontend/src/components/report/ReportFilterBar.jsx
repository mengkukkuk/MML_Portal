import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { fetchCatalog } from '@/api/reports'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { PRESETS } from './reportRange'
import styles from './ReportFilterBar.module.css'

/**
 * ReportFilterBar — window, line and camera selection.
 *
 * Uses DateTimePicker rather than DatePicker: a date-only picker silently
 * rounds the window to midnight, which on a 3-shift line moves real inspection
 * activity into or out of the report. Time is part of the question being asked.
 *
 * Line and camera options come from /reports/catalog, which lists the distinct
 * cameras registered in vision_data.cameras.
 *
 * The catalogue spans every selected source and the options are deduplicated by
 * *code*, not by camera identity. That is deliberate: the filters travel to the
 * server as plain location and code strings and are applied to each source
 * independently, so picking `Line 1` means "Line 1 wherever it exists". The
 * report itself still separates the two plants — see `_camera_key`.
 */

export default function ReportFilterBar({ filters, onChange, onRefresh, isFetching }) {
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)
  const catalogQuery = useQuery({
    queryKey: ['report', 'catalog', selectionKey],
    queryFn: () => fetchCatalog(),
    staleTime: 5 * 60_000,
  })

  const catalog = catalogQuery.data ?? []

  const locations = useMemo(
    () => [...new Set(catalog.map((c) => c.location).filter(Boolean))].sort(),
    [catalog],
  )

  // Cameras are scoped to the selected lines — offering a camera that cannot
  // appear in the result is just a way to produce a confusing empty report.
  const cameras = useMemo(() => {
    const rows = filters.locations.length
      ? catalog.filter((c) => filters.locations.includes(c.location))
      : catalog
    // Dedupe by code but keep a friendly label when one exists.
    const byCode = new Map()
    for (const c of rows) {
      if (c.code && !byCode.has(c.code)) byCode.set(c.code, c.name || c.code)
    }
    return [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [catalog, filters.locations])

  function set(patch) {
    onChange({ ...filters, ...patch })
  }

  function setLocations(next) {
    // Drop any camera selection the new line set can no longer produce.
    const allowed = new Set(
      (next.length ? catalog.filter((c) => next.includes(c.location)) : catalog).map(
        (c) => c.code,
      ),
    )
    set({
      locations: next,
      cameraCodes: filters.cameraCodes.filter((code) => allowed.has(code)),
    })
  }

  const isCustom = filters.preset === 'custom'
  const hasFilters = filters.locations.length > 0 || filters.cameraCodes.length > 0

  return (
    <div className={`${styles.bar} report-filters`}>
      <div className={styles.group}>
        <span className={styles.label}>Range</span>
        <FormControl size="small" className={styles.preset}>
          <Select value={filters.preset} onChange={(e) => set({ preset: e.target.value })}>
            {Object.entries(PRESETS).map(([key, p]) => (
              <MenuItem key={key} value={key}>
                {p.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>

      {isCustom && (
        <div className={styles.group}>
          <DateTimePicker
            value={filters.start}
            onChange={(v) => set({ start: v })}
            format="DD/MM/YYYY HH:mm"
            ampm={false}
            slotProps={{ textField: { size: 'small', className: styles.picker } }}
          />
          <span className={styles.sep}>–</span>
          <DateTimePicker
            value={filters.end}
            onChange={(v) => set({ end: v })}
            format="DD/MM/YYYY HH:mm"
            ampm={false}
            slotProps={{ textField: { size: 'small', className: styles.picker } }}
          />
        </div>
      )}

      <div className={styles.group}>
        <span className={styles.label}>Line</span>
        <FormControl size="small" className={styles.select}>
          <Select
            multiple
            displayEmpty
            value={filters.locations}
            onChange={(e) => setLocations(e.target.value)}
            renderValue={(v) => (v.length ? v.join(', ') : 'All lines')}
          >
            {locations.map((loc) => (
              <MenuItem key={loc} value={loc}>
                <Checkbox size="small" checked={filters.locations.includes(loc)} />
                <ListItemText primary={loc} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>

      <div className={styles.group}>
        <span className={styles.label}>Camera</span>
        <FormControl size="small" className={styles.select}>
          <Select
            multiple
            displayEmpty
            value={filters.cameraCodes}
            onChange={(e) => set({ cameraCodes: e.target.value })}
            renderValue={(v) => (v.length ? v.join(', ') : 'All cameras')}
          >
            {cameras.map(([code, label]) => (
              <MenuItem key={code} value={code}>
                <Checkbox size="small" checked={filters.cameraCodes.includes(code)} />
                <ListItemText primary={label} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>

      {hasFilters && (
        <Button size="small" onClick={() => set({ locations: [], cameraCodes: [] })}>
          Clear
        </Button>
      )}

      <Button size="small" variant="outlined" loading={isFetching} onClick={onRefresh}>
        Run
      </Button>
    </div>
  )
}
