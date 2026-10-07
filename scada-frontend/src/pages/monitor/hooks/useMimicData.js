import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import usePlantData from '@/components/mimic/usePlantData'
import useMimicTables from '@/components/mimic/useMimicTables'
import { setCustomDefs } from '@/components/mimic/symbols'
import { fetchDatasources } from '@/api/datasources'
import { fetchMimicSymbols } from '@/api/mimicAssets'
import { kpiPollNodes } from '../kpiBoxes'
import {
  connectionCounts, overviewSubtitle, plantStatusOf, rankAttention,
} from '../monitorStatus'

/**
 * Everything the drawing reads from the plant: the poll cadence, the merged
 * tag snapshot, connection health, the datasource list and the custom symbol
 * library — plus the figures derived from them for the page chrome.
 */
export default function useMimicData({ nodes, kpis }) {
  const [liveMs, setLiveMs] = useState(5000)
  // The cover over the sub-second rates. Closed on every page load: an elevated
  // rate is something you choose for a job in hand, not something you inherit.
  const [fastOpen, setFastOpen] = useState(false)

  /**
   * What the plant poller is asked for: the drawing's bindings plus the
   * strip's, in one list.
   *
   * The strip could have run its own query. It must not: a second clock would
   * ignore the cadence control, and the figure above the sheet would drift a
   * tick out of step with the symbols below it — which on a wall display is a
   * support call about numbers that disagree.
   */
  const pollNodes = useMemo(
    () => [...nodes, ...kpiPollNodes(kpis)],
    [nodes, kpis],
  )

  const {
    tags: plantTags, history, events, error: dataError, sources: connSources,
  } = usePlantData({
    nodes: pollNodes, pollSeconds: liveMs / 1000,
  })
  const anySourceFailed = connSources.some((s) => !s.ok)

  // Table symbols read rows, not a reading, so they poll on their own — see
  // useMimicTables for why that is a sibling rather than a branch inside the
  // value poller. The result is folded back into the same tag entries so the
  // canvas keeps one map to look things up in.
  const tableData = useMimicTables({ nodes, pollSeconds: liveMs / 1000 })
  const tags = useMemo(() => {
    const ids = Object.keys(tableData)
    if (!ids.length) return plantTags
    const merged = { ...plantTags }
    ids.forEach((id) => { merged[id] = { ...merged[id], table: tableData[id] } })
    return merged
  }, [plantTags, tableData])

  const datasourcesQuery = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources })

  /**
   * The custom symbol library.
   *
   * Published into the symbol registry (setCustomDefs) rather than passed down as
   * a prop, because the consumers are synchronous module functions — portPoint
   * routes every wire, resizeBox sizes a drag — and threading an async value
   * through all of them would turn each into a hook. See the note on CUSTOM_DEFS.
   *
   * A drawing renders before this lands. That is fine and expected: a custom node
   * falls back to a frame with no picture until its definition arrives, then fills
   * in. It is the reason the unknown-type path had to be made safe first.
   */
  const customSymbolsQuery = useQuery({
    queryKey: ['mimic-symbols'],
    queryFn: fetchMimicSymbols,
  })
  const customSymbols = useMemo(() => customSymbolsQuery.data || [], [customSymbolsQuery.data])

  // Published during render, not in an effect. The canvas reads the registry
  // synchronously while rendering, so an effect would fire *after* the first
  // paint that needed the new definitions — every custom symbol would draw
  // frameless for one frame, then pop in. Guarded by identity so it runs once
  // per fetch, and idempotent either way.
  const publishedRef = useRef(null)
  if (publishedRef.current !== customSymbols) {
    publishedRef.current = customSymbols
    setCustomDefs(customSymbols)
  }

  const subtitle = useMemo(() => {
    const { connected, backendCount } = connectionCounts(nodes)
    return overviewSubtitle(nodes.length, connected, backendCount)
  }, [nodes])
  const plantStatus = useMemo(() => plantStatusOf(nodes, tags), [nodes, tags])
  const attention = useMemo(() => rankAttention(nodes, tags), [nodes, tags])

  return {
    liveMs,
    setLiveMs,
    fastOpen,
    setFastOpen,
    tags,
    history,
    events,
    dataError,
    connSources,
    anySourceFailed,
    datasources: datasourcesQuery.data || [],
    customSymbols,
    subtitle,
    plantStatus,
    attention,
  }
}
