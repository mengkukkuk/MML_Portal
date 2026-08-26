import { useMemo } from 'react'
import useMockPlant from './useMockPlant'
import useMimicPlant from './useMimicPlant'

/**
 * usePlantData — one switch between the demo simulator and real plant data.
 *
 * Hooks can't be called conditionally, so both run and the inactive one is
 * parked: `tickMs: null` stops the simulator's timer, `enabled: false` stops
 * the poller's queries. Neither does any work it isn't being watched for.
 *
 * The two sources disagree about one thing only — the simulator keys its
 * snapshot by loop id (its tag dictionary predates bindings), the poller keys
 * by node id. Remapping happens here, once, so everything downstream sees a
 * single shape and no component has to know which source is live.
 */

const EMPTY = {
  tags: {}, history: {}, events: [], ts: 0, running: false, error: '', sources: [],
}

/**
 * Re-key the simulator's snapshot onto node ids via each node's `tagId`.
 *
 * Events are *fanned out* rather than mapped: several symbols may print the
 * same loop id, and in demo mode they genuinely share one simulated tag. Giving
 * the event to only the first matching node would leave the others looking
 * permanently steady while their reading visibly changed.
 */
function remapDemo(snapshot, nodes) {
  const tags = {}
  const history = {}
  const nodesByTag = new Map()

  nodes.forEach((node) => {
    if (!node.tagId) return
    const tag = snapshot.tags[node.tagId]
    if (!tag) return
    // The node's own label wins: on the drawing the asset is named by what it
    // is ("D-200 steam drum"), not by what the simulator calls its loop.
    //
    // condValue mirrors deriveTag's own rule so a case/alarm rule behaves
    // identically against demo data: the simulator has no state.map to
    // detect, but a purely discrete tag (the stack light, the belt switch)
    // has no `value` either, and a rule testing its word has to land on
    // `state` the same way it does against a live-polled tag.
    tags[node.id] = {
      ...tag, label: node.label ?? tag.label, condValue: tag.value ?? tag.state,
    }
    const points = snapshot.history[node.tagId]
    if (points) history[node.id] = points
    if (!nodesByTag.has(node.tagId)) nodesByTag.set(node.tagId, [])
    nodesByTag.get(node.tagId).push(node.id)
  })

  const events = []
  snapshot.events.forEach((e) => {
    const owners = nodesByTag.get(e.tag)
    if (!owners) return
    owners.forEach((nodeId) => events.push({ ...e, nodeId }))
  })

  return {
    tags,
    history,
    events,
    ts: snapshot.ts,
    running: snapshot.running,
    error: '',
    // Demo mode has no real datasources to report on.
    sources: [],
  }
}

export default function usePlantData({
  nodes = [],
  demo = false,
  tickMs = 1000,
  pollSeconds = 5,
  historyMinutes,
  refreshSignal = 0,
}) {
  const mock = useMockPlant({ tickMs: demo ? tickMs : null })
  const live = useMimicPlant({
    nodes, pollSeconds, historyMinutes, refreshSignal, enabled: !demo,
  })

  const demoSnapshot = useMemo(
    () => (demo ? remapDemo(mock, nodes) : EMPTY),
    [demo, mock, nodes],
  )

  return {
    ...(demo ? demoSnapshot : live),
    // Only meaningful in demo mode; MonitorPage hides the control otherwise,
    // where it would drive a simulator nothing is reading.
    simulateExcursion: mock.simulateExcursion,
    excursionTag: demo ? mock.excursionTag ?? null : null,
  }
}
