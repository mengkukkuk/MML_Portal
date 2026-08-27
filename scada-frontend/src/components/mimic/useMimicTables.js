import { useMemo } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { fetchSchemaRows, fromPrimarySource } from '@/api/schema'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import { apiErrorMessage } from '@/api/client'
import { tableColumns, tableRowLimit } from './symbols/DataTable'

/**
 * useMimicTables — the row poller for table symbols.
 *
 * ## Why this is not part of useMimicPlant
 *
 * That hook exists to produce one *coherent* reading per symbol: it carries
 * history across ticks, fires a pulse when a value changes, writes an event
 * trail, and reduces every tag into one plant status. None of that applies to a
 * projection of rows. A table has no trend to accumulate, no single value to
 * compare against a limit, and nothing to contribute to "is the plant running".
 * Folding it in would mean threading a second, differently-shaped payload
 * through the seed/poll accumulator that exists only to append points.
 *
 * So it is a sibling on the same clock instead: same `pollSeconds`, same
 * selection key, and MonitorPage merges the result into the same tag entries,
 * which is where the symbols already look.
 *
 * ## One request per table symbol
 *
 * Two tables on a drawing are two different projections — different columns,
 * different filters, usually different tables — so there is nothing to batch.
 * `allSettled` keeps one broken projection from blanking the others, exactly as
 * the value poller does with bindings.
 */

const EMPTY = {}

/** The binding + structure fields that change what the query returns. */
function signatureOf(items) {
  return items
    .map(({ nodeId, b, columns, limit }) => [
      nodeId, b.table, b.ts_col, b.filter_col, b.filter_val, b.datasource_id,
      columns.join(','), limit,
    ].join('|'))
    .join('\n')
}

export default function useMimicTables({ nodes = [], pollSeconds = 5, enabled = true }) {
  const selectionKey = useDatasourceSelectionStore((s) => s.selectionKey)

  const items = useMemo(() => nodes
    .filter((n) => n.type === 'table' && n.binding?.table)
    .map((n) => ({
      nodeId: n.id,
      b: n.binding,
      // Names only: the rest of a column spec (title, width, decimals) is
      // presentation, and retyping a header must not refetch the plant.
      columns: tableColumns(n).map((c) => c.col),
      limit: tableRowLimit(n),
    }))
    .filter(({ columns }) => columns.length > 0), [nodes])

  const signature = useMemo(() => signatureOf(items), [items])

  const query = useQuery({
    queryKey: ['mimic-tables', selectionKey, signature],
    enabled: enabled && items.length > 0,
    queryFn: async () => {
      const results = await Promise.allSettled(items.map(({ b, columns, limit }) => (
        fetchSchemaRows({
          table: b.table,
          columns,
          tsCol: b.ts_col || undefined,
          filterCol: b.filter_col || undefined,
          filterVal: b.filter_val ?? undefined,
          limit,
          datasourceId: b.datasource_id ?? undefined,
        })
      )))

      const out = {}
      results.forEach((res, i) => {
        const { nodeId, columns } = items[i]
        if (res.status !== 'fulfilled') {
          out[nodeId] = { columns, rows: [], error: apiErrorMessage(res.reason) }
          return
        }
        // A symbol is one physical asset, so it reads the primary source and
        // never merges plants into one grid — the same rule the value poller
        // follows, and for the same reason: two plants' rows in one table would
        // be indistinguishable once drawn.
        const one = fromPrimarySource(res.value.tables, res.value.sources)
        out[nodeId] = { columns: one?.columns ?? columns, rows: one?.rows ?? [], error: '' }
      })
      return out
    },
    refetchInterval: pollSeconds * 1000,
    // A SCADA wall display must not freeze in a background tab.
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
  })

  return (enabled && query.data) || EMPTY
}
