import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fetchKpiSummary, previewKpi } from '@/api/kpi'

/**
 * useKpiSummary — one management block's figures, polled at the panel's own
 * cadence (`poll_interval_seconds`, 30 s minimum for these blocks).
 *
 * A saved block reads `/kpi/summary?panel_id=`; while the inspector is editing
 * it (`draft` set) the tile previews the unsaved settings through
 * `/kpi/preview` instead, debounced so typing a price doesn't fire a query per
 * keystroke. The previous figures stay on screen while the next ones load.
 */
export function useKpiSummary(panel, { draft = null, refreshSignal = 0 } = {}) {
  const [debounced, setDebounced] = useState(draft)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(draft), 500)
    return () => clearTimeout(id)
  }, [draft])

  const previewing = !!debounced
  const bound = previewing ? !!debounced.table_name : !!panel.table_name
  return useQuery({
    queryKey: previewing
      ? ['kpi-preview', panel.chart_type, debounced]
      : ['kpi-summary', panel.id, panel.options?.kpi, panel.table_name, panel.datasource_id, refreshSignal],
    queryFn: () => (previewing
      ? previewKpi({ chart_type: panel.chart_type, table_name: debounced.table_name,
        datasource_id: debounced.datasource_id, kpi: debounced.kpi })
      : fetchKpiSummary(panel.id)),
    enabled: bound,
    refetchInterval: previewing ? false : Math.max(30, panel.poll_interval_seconds || 60) * 1000,
    placeholderData: keepPreviousData,
  })
}
