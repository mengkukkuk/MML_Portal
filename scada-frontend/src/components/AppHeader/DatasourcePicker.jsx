import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Chip from '@mui/material/Chip'
import FormControl from '@mui/material/FormControl'
import ListItemText from '@mui/material/ListItemText'
import Checkbox from '@mui/material/Checkbox'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import StorageOutlined from '@mui/icons-material/StorageOutlined'

import { fetchDatasources, saveSelection } from '@/api/datasources'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import styles from './DatasourcePicker.module.css'

/**
 * DatasourcePicker — which plant databases the pages read from.
 *
 * Multi-select: an operator responsible for several plants sees them merged
 * rather than having to switch back and forth. Live draws one series per source,
 * Events and Alarms merge rows tagged with their origin, and Monitor uses the
 * first — a mimic symbol is one physical asset, so overlaying plants on it would
 * be meaningless.
 *
 * The selection is stored server-side per user; this component only reflects and
 * writes it. After a successful write every query is invalidated, but that alone
 * would not be enough: the polling hooks key their accumulated history by query
 * key and would splice the new plant's points onto the old plant's series. The
 * store's `selectionKey` is part of those keys, which is what makes them reseed.
 */
export default function DatasourcePicker() {
  const queryClient = useQueryClient()
  const selected = useDatasourceSelectionStore((s) => s.selected)
  const implicit = useDatasourceSelectionStore((s) => s.implicit)
  const hydrate = useDatasourceSelectionStore((s) => s.hydrate)
  const apply = useDatasourceSelectionStore((s) => s.apply)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const { data: sources = [] } = useQuery({
    queryKey: ['datasources'],
    queryFn: fetchDatasources,
    staleTime: 60_000,
  })

  const { mutate, isPending } = useMutation({
    mutationFn: saveSelection,
    onSuccess: (data) => {
      apply(data)
      // Coarse on purpose: every data query in the app is now reading from a
      // different set of databases.
      queryClient.invalidateQueries()
    },
  })

  // Deselecting everything is meaningful — it restores the implicit default —
  // so an empty array is sent rather than ignored.
  const ids = selected.map((d) => d.id)

  if (!sources.length) return null

  return (
    <FormControl size="small" className={styles.control}>
      <Select
        multiple
        displayEmpty
        value={ids}
        disabled={isPending}
        onChange={(e) => mutate(e.target.value)}
        renderValue={() => (
          <span
            className={styles.value}
            data-implicit={implicit || undefined}
            title={
              implicit
                ? 'No source chosen — showing the first saved connection.'
                : undefined
            }
          >
            <StorageOutlined className={styles.icon} fontSize="inherit" />
            {selected.length === 0 ? (
              <span className={styles.empty}>No data source</span>
            ) : (
              selected.map((d) => (
                <Chip key={d.id} size="small" className={styles.chip} label={d.name} />
              ))
            )}
            {implicit && selected.length > 0 && (
              <span className={styles.default}>(default)</span>
            )}
          </span>
        )}
        inputProps={{ 'aria-label': 'Data sources' }}
        MenuProps={{ PaperProps: { style: { maxHeight: 360 } } }}
      >
        {sources.map((ds) => (
          <MenuItem key={ds.id} value={ds.id} dense>
            <Checkbox size="small" checked={ids.includes(ds.id)} />
            <ListItemText
              primary={ds.name}
              secondary={`${ds.host}:${ds.port}/${ds.database}`}
              secondaryTypographyProps={{ fontSize: 11 }}
            />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}
