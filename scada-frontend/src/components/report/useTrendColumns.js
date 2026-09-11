import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSchemaColumns } from '@/api/schema'
import { fetchCameraLinkOptions } from '@/api/cameras'
import { buildDefectLabelsByCode } from '@/utils/defectLabels'
import { groupReadings } from './readingGroups'

/** Share the table inspection between the controls and the rendered chart. */
export function useTrendColumns(table, primaryId) {
  const query = useQuery({
    queryKey: ['trend', 'columns', primaryId ?? 'app', table],
    queryFn: () => fetchSchemaColumns(table, primaryId ?? undefined),
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
  const groups = useMemo(
    () => groupReadings(query.data?.array_value_columns, labelsByCode),
    [query.data, labelsByCode],
  )
  return { query, groups }
}
