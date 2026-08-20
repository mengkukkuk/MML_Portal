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
import { PRESETS } from './reportRange'
import styles from './ReportFilterBar.module.css'

/**
 * ReportFilterBar — window, line and machine selection.
 *
 * Uses DateTimePicker rather than DatePicker: a date-only picker silently
 * rounds the window to midnight, which on a 3-shift line moves real downtime
 * into or out of the report. Time is part of the question being asked.
 *
 * Line and machine options come from /reports/catalog, which unions
 * variables_tag with the distinct machines in event_logs — so a machine that
 * has been decommissioned out of variables_tag can still be reported on
 * historically.
 */

export default function ReportFilterBar({ filters, onChange, onRefresh, isFetching }) {
  const catalogQuery = useQuery({
    queryKey: ['report', 'catalog'],
    queryFn: () => fetchCatalog(),
    staleTime: 5 * 60_000,
  })

  const catalog = catalogQuery.data ?? []

  const locations = useMemo(
    () => [...new Set(catalog.map((c) => c.location).filter(Boolean))].sort(),
    [catalog],
  )

  // Machines are scoped to the selected lines — offering a machine that cannot
  // appear in the result is just a way to produce a confusing empty report.
  const tags = useMemo(() => {
    const rows = filters.locations.length
      ? catalog.filter((c) => filters.locations.includes(c.location))
      : catalog
    return [...new Set(rows.map((c) => c.tag_name).filter(Boolean))].sort()
  }, [catalog, filters.locations])

  function set(patch) {
    onChange({ ...filters, ...patch })
  }

  function setLocations(next) {
    // Drop any machine selection the new line set can no longer produce.
    const allowed = new Set(
      (next.length ? catalog.filter((c) => next.includes(c.location)) : catalog).map(
        (c) => c.tag_name,
      ),
    )
    set({
      locations: next,
      tagNames: filters.tagNames.filter((t) => allowed.has(t)),
    })
  }

  const isCustom = filters.preset === 'custom'
  const hasFilters = filters.locations.length > 0 || filters.tagNames.length > 0

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
        <span className={styles.label}>Machine</span>
        <FormControl size="small" className={styles.select}>
          <Select
            multiple
            displayEmpty
            value={filters.tagNames}
            onChange={(e) => set({ tagNames: e.target.value })}
            renderValue={(v) => (v.length ? v.join(', ') : 'All machines')}
          >
            {tags.map((tag) => (
              <MenuItem key={tag} value={tag}>
                <Checkbox size="small" checked={filters.tagNames.includes(tag)} />
                <ListItemText primary={tag} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>

      {hasFilters && (
        <Button size="small" onClick={() => set({ locations: [], tagNames: [] })}>
          Clear
        </Button>
      )}

      <Button size="small" variant="outlined" loading={isFetching} onClick={onRefresh}>
        Run
      </Button>
    </div>
  )
}
