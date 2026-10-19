import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSchemaColumns } from '@/api/schema'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { fetchTagLocations } from '@/api/tags'
import { buildDefectLabelsByCode } from '@/utils/defectLabels'
import { columnsAt, groupReadings, locationsFor } from './readingGroups'

const NO_ROWS = []

/**
 * Share the table inspection between the controls and the rendered chart.
 *
 * `location` narrows the reading columns to the tags variables_tag places on
 * that line ('' is every column). `locations` is what can be picked: only lines
 * that own a column of this table, and none at all when the source keeps no
 * tag locations — the control then stays hidden and nothing is narrowed.
 */
export function useTrendColumns(table, sourceId, location = '') {
  const query = useQuery({
    queryKey: ['trend', 'columns', sourceId ?? 'app', table],
    queryFn: () => fetchSchemaColumns(table, sourceId ?? undefined),
    enabled: !!table,
    staleTime: 5 * 60_000,
  })
  // Same query the Monitor camera rail uses, so the two share one cache entry.
  // A `defect_n` column only gets a human label when its group key matches a
  // camera's code here — an unconfigured or errored source just yields no map,
  // and every reading keeps its raw name exactly as before.
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
  const tagLocationsQuery = useQuery({
    queryKey: ['trend', 'tag-locations', sourceId ?? 'app'],
    queryFn: () => fetchTagLocations(sourceId ?? undefined),
    enabled: !!table,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const tagRows = tagLocationsQuery.data ?? NO_ROWS
  const allColumns = query.data?.array_value_columns
  const locations = useMemo(() => locationsFor(allColumns, tagRows), [allColumns, tagRows])
  // A location this table does not offer narrows nothing — the rail clears it,
  // and until it does the chart must not go blank over a stale link.
  const effective = locations.includes(location) ? location : ''
  const columns = useMemo(
    () => columnsAt(allColumns ?? [], tagRows, effective),
    [allColumns, tagRows, effective],
  )
  const groups = useMemo(
    () => groupReadings(columns, labelsByCode),
    [columns, labelsByCode],
  )
  return { query, groups, locations, columns, locationsReady: !tagLocationsQuery.isLoading }
}
