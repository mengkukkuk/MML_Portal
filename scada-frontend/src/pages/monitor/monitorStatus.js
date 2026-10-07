/**
 * What the Monitor page says about a plant, derived from its drawing and the
 * latest poll — pure, so it is unit-tested (monitorStatus.test.js).
 */
import { worseStatus } from '../../components/mimic/tagStatus.js'

/**
 * Reduced over the *drawing's* nodes, not over every tag in the snapshot.
 * The banner answers "is this plant in alarm", and a headline box that went
 * stale because someone renamed a column is a strip problem, not a plant one
 * — it must not light up the status a control room reads the page by.
 */
export function plantStatusOf(nodes, tags) {
  return nodes.reduce((acc, n) => worseStatus(acc, tags[n.id]?.status ?? 'normal'), 'normal')
}

/**
 * One word for the whole plant, derived once. The page header and the full
 * screen banner are two readings of the same thing and must never differ.
 */
export function statusLabelOf(status) {
  return status === 'crit' ? 'Alarm' : status === 'warn' ? 'Off normal' : 'Running'
}

/**
 * The attention list's order and counts. Rank: 0 alarm, 1 off normal,
 * 2 not connected, 3 healthy — then sheet order within a rank, so a list
 * that doesn't change doesn't reshuffle on every poll.
 */
export function rankAttention(nodes, tags) {
  const ranked = nodes.map((node, i) => {
    const tag = tags[node.id]
    const rank = tag?.status === 'crit' ? 0 : tag?.status === 'warn' ? 1 : !tag ? 2 : 3
    return { node, tag, rank, i }
  })
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i)
  const count = (r) => ranked.filter((x) => x.rank === r).length
  return { ordered: ranked, crit: count(0), warn: count(1), unbound: count(2) }
}

/** A symbol counts as connected once it names a table and a value column. */
export const isBound = (n) => !!(n.binding?.table && n.binding?.value_col)

/** How many symbols are connected, and across how many distinct backends. */
export function connectionCounts(nodes) {
  const bound = nodes.filter(isBound)
  const backends = new Set(bound.map((n) => n.binding.datasource_id ?? 'app'))
  return { connected: bound.length, backendCount: backends.size }
}

export function overviewSubtitle(total, connected, backendCount) {
  if (total === 0) return 'Empty drawing · add symbols from the palette in edit mode'
  if (connected === 0) return 'No symbols connected yet'
  return `${connected} of ${total} symbols connected · ${backendCount} ${backendCount === 1 ? 'connection' : 'connections'}`
}
