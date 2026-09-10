import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSchemaColumns } from '@/api/schema'
import { groupReadings } from './readingGroups'

/** Share the table inspection between the controls and the rendered chart. */
export function useTrendColumns(table, primaryId) {
  const query = useQuery({
    queryKey: ['trend', 'columns', primaryId ?? 'app', table],
    queryFn: () => fetchSchemaColumns(table, primaryId ?? undefined),
    enabled: !!table,
    staleTime: 5 * 60_000,
  })
  const groups = useMemo(() => groupReadings(query.data?.array_value_columns), [query.data])
  return { query, groups }
}
