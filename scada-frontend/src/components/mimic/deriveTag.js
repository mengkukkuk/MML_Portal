import { symbolDef } from './symbols'
import { analogStatus } from './tagStatus'

/**
 * deriveTag — turns one raw reading into one snapshot entry.
 *
 * Pure by design: everything that carries across ticks (previous entry, pulse
 * counter) is passed in and handed back, so the poller owns the mutable state
 * and this file can be reasoned about — and tested — one sample at a time.
 *
 * The simulator does the same derivation inline in createPlantSim. Both end at
 * the same entry shape (see tagStatus.js), which is the whole reason a symbol
 * never has to know which source it is drawing.
 */

export const EVENT_LOG_SIZE = 30

/** Entry counts as stale after this many missed polls. */
const STALE_POLLS = 3

/**
 * How old a row may be before the symbol calls it stale.
 *
 * Cadence tells you how often you *ask*; it does not make the answer older. A
 * historian written once every five seconds is healthy whether it is read every
 * five seconds or ten times a second — so the window never tightens below the
 * slowest cadence the page used to offer, and every symbol on a 100ms poll
 * would otherwise flip to stale within 300ms.
 */
const STALE_FLOOR_MS = 15_000

export function staleAfterMs(pollSeconds) {
  return Math.max(pollSeconds * 1000 * STALE_POLLS, STALE_FLOOR_MS)
}

const KIND_BY_BINDING = {
  analog: 'analog', both: 'both', discrete: 'discrete', none: 'analog',
}

function round(v, decimals) {
  if (v == null) return null
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

/**
 * Run/stop (or a mapped beacon colour) from a numeric reading.
 *
 * /api/schema/latest returns a float, so a state column has to be *derived*
 * from a number rather than read as text — that is the deliberate limit of
 * this pass, not an oversight. `threshold` covers drives (running above a
 * setpoint, invertible for fail-closed signals); `map` covers coded values
 * like a beacon's 0/1/2.
 */
export function deriveState(cfg, value) {
  if (!cfg || value == null) return null
  if (cfg.mode === 'map') {
    const hit = cfg.map?.[String(Math.round(value))]
    return hit ?? null
  }
  const above = value > (cfg.runAbove ?? 0.5)
  return (cfg.invert ? !above : above) ? 'run' : 'stop'
}

/**
 * Build one entry for one node.
 *
 * `reading` is `{ value, ts }`, or null when the poll produced nothing for
 * this node — a failed request, an empty table, or a binding that was only
 * just added. A null reading never blanks the symbol: the previous entry is
 * carried forward and marked stale, because a operator glancing at a wall
 * display needs to see the last known number *and* that it stopped moving.
 */
export function deriveTag({
  node, reading, prev, pulse = 0, now = Date.now(), pollSeconds = 5,
}) {
  const b = node.binding || {}
  const decimals = b.decimals ?? 1
  const limits = b.limits || {
    warnLo: null, warnHi: null, critLo: null, critHi: null,
  }
  const kind = KIND_BY_BINDING[symbolDef(node)?.binding] ?? 'analog'

  const value = reading?.value ?? prev?.value ?? null
  const ts = reading?.ts ?? prev?.ts ?? now
  const display = round(value, decimals)
  const state = deriveState(b.state, value)

  // Two ways to go stale: the poll returned nothing, or the row it returned is
  // older than the reader expects. The second is the one that catches a
  // historian that is up but no longer being written to — the failure mode a
  // "connection ok" check would call healthy.
  const missed = reading == null && prev != null
  const aged = now - ts > staleAfterMs(pollSeconds)
  const stale = value == null || missed || aged

  const status = stale
    ? 'stale'
    // A stopped drive is off duty, not in alarm — same rule the simulator uses.
    : state === 'stop' ? 'normal' : analogStatus(limits, value)

  const changed = prev
    ? display !== prev.display || state !== prev.state
    : false
  const nextPulse = changed ? pulse + 1 : pulse

  const entry = {
    id: node.tagId ?? node.id,
    label: node.label ?? node.tagId ?? node.id,
    unit: b.unit ?? '',
    kind,
    decimals,
    range: b.range ?? null,
    limits,
    value,
    prevValue: prev ? prev.value : value,
    display,
    prevDisplay: prev ? prev.display : display,
    state,
    status,
    prevStatus: prev ? prev.status : status,
    pulse: nextPulse,
    ts,
  }

  // Events carry the node id as well as the printed loop id: two symbols may
  // watch one loop, and the rail must never show one node's transitions under
  // the other.
  const event = prev && prev.status !== status
    ? {
      ts: now, nodeId: node.id, tag: entry.id, from: prev.status, to: status,
    }
    : null

  return { entry, pulse: nextPulse, event }
}
