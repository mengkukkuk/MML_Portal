/**
 * mockPlant — a self-contained simulator for one boiler / steam skid.
 *
 * This file is the ONLY source of values on /monitor. There is no backend
 * call and no `src/api/*` module for the mimic; the page is a drawing of a
 * plant that does not exist. The snapshot shape below is deliberately the
 * same shape a real poll would return, so swapping in `usePanelPolling`
 * later is a hook replacement rather than a rewrite.
 *
 * Snapshot contract (one flat map, one shape — `node.tag` must resolve in a
 * single lookup):
 *
 *   {
 *     tags: {
 *       'TT-202': { id, label, value, prevValue, display, prevDisplay,
 *                   state, status, prevStatus, unit, decimals, kind,
 *                   range: [lo, hi], limits: {…}, pulse, ts },
 *     },
 *     history: { 'TT-202': [[ts, value], …] },   // analog tags only, 120 pts
 *     events:  [{ ts, tag, from, to }],          // newest first, 30 kept
 *     ts, running,
 *   }
 *
 * Analog tags leave `state` null, discrete tags leave `value` null, and a
 * pump carries both. `status` is derived here exactly once — symbols and the
 * detail rail never recompute it.
 */

const HISTORY_POINTS = 120
const EVENT_LOG_SIZE = 30

/** Lead/lag feedwater pumps swap duty on this cadence (ms). */
const PUMP_SWAP_MS = 90_000

/** How long "Simulate excursion" holds a tag above its high-high limit (ms). */
export const EXCURSION_MS = 15_000

/**
 * Tag dictionary. `base/amp/period/noise` drive the generator; `warnLo/warnHi`
 * and `critLo/critHi` derive `status`. `period` is in seconds.
 */
export const TAG_DEFS = {
  'LT-100': {
    label: 'Condensate tank level',
    unit: '%',
    kind: 'analog',
    decimals: 1,
    range: [0, 100],
    base: 68, amp: 7, period: 71, noise: 0.35,
    warnLo: 35, warnHi: 88, critLo: 20, critHi: 95,
  },
  'LT-102': {
    label: 'Steam drum level',
    unit: '%',
    kind: 'analog',
    decimals: 1,
    range: [0, 100],
    base: 54, amp: 5, period: 43, noise: 0.5,
    warnLo: 35, warnHi: 72, critLo: 25, critHi: 82,
  },
  'FT-101': {
    label: 'Feedwater flow',
    unit: 't/h',
    kind: 'analog',
    decimals: 1,
    range: [0, 60],
    base: 42, amp: 4, period: 37, noise: 0.4,
    warnLo: 26, warnHi: 52, critLo: 18, critHi: 57,
  },
  'HX-701': {
    label: 'Economiser duty',
    unit: 'kW',
    kind: 'analog',
    decimals: 0,
    range: [0, 1400],
    base: 940, amp: 90, period: 59, noise: 8,
    warnLo: 600, warnHi: 1200, critLo: 400, critHi: 1320,
  },
  'PT-201': {
    label: 'Steam header pressure',
    unit: 'bar',
    kind: 'analog',
    decimals: 2,
    range: [0, 12],
    base: 8.4, amp: 0.45, period: 53, noise: 0.05,
    warnLo: 6.5, warnHi: 9.8, critLo: 5.5, critHi: 10.6,
  },
  'TT-202': {
    label: 'Steam temperature',
    unit: '°C',
    kind: 'analog',
    decimals: 1,
    range: [80, 240],
    base: 184, amp: 6, period: 47, noise: 0.5,
    warnLo: 150, warnHi: 195, critLo: 120, critHi: 208,
  },
  'TT-203': {
    label: 'Flue gas temperature',
    unit: '°C',
    kind: 'analog',
    decimals: 1,
    range: [60, 320],
    base: 212, amp: 14, period: 67, noise: 1.2,
    warnLo: 150, warnHi: 260, critLo: 110, critHi: 290,
  },
  'O2-402': {
    label: 'Flue gas oxygen',
    unit: '%',
    kind: 'analog',
    decimals: 2,
    range: [0, 12],
    base: 3.1, amp: 0.6, period: 41, noise: 0.08,
    warnLo: 2.0, warnHi: 5.0, critLo: 1.2, critHi: 6.5,
  },
  'FCV-301': {
    label: 'Steam control valve',
    unit: '%',
    kind: 'analog',
    decimals: 0,
    range: [0, 100],
    base: 64, amp: 11, period: 61, noise: 0.8,
    warnLo: 15, warnHi: 92, critLo: 5, critHi: 98,
  },
  'BR-401': {
    label: 'Burner firing rate',
    unit: '%',
    kind: 'analog',
    decimals: 0,
    range: [0, 100],
    base: 72, amp: 13, period: 49, noise: 1,
    warnLo: 20, warnHi: 94, critLo: 8, critHi: 99,
  },
  'P-101A': {
    label: 'Feedwater pump A',
    unit: 'A',
    kind: 'both',
    decimals: 1,
    range: [0, 30],
    base: 12.4, amp: 0.8, period: 31, noise: 0.15,
    warnLo: 6, warnHi: 22, critLo: 3, critHi: 26,
    states: ['run', 'stop'],
  },
  'P-101B': {
    label: 'Feedwater pump B',
    unit: 'A',
    kind: 'both',
    decimals: 1,
    range: [0, 30],
    base: 12.1, amp: 0.8, period: 29, noise: 0.15,
    warnLo: 6, warnHi: 22, critLo: 3, critHi: 26,
    states: ['run', 'stop'],
  },
  'M-505': {
    label: 'Conveyor drive motor',
    unit: 'A',
    kind: 'both',
    decimals: 1,
    range: [0, 20],
    base: 7.6, amp: 0.6, period: 33, noise: 0.12,
    warnLo: 3, warnHi: 14, critLo: 1, critHi: 17,
    states: ['run', 'stop'],
  },
  'CV-501': {
    label: 'Fuel conveyor speed',
    unit: 'm/s',
    kind: 'both',
    decimals: 2,
    range: [0, 2.5],
    base: 1.35, amp: 0.15, period: 39, noise: 0.02,
    warnLo: 0.6, warnHi: 2.0, critLo: 0.3, critHi: 2.3,
    states: ['run', 'stop'],
  },
  'XV-503': {
    label: 'Fuel damper',
    unit: '%',
    kind: 'both',
    decimals: 0,
    range: [0, 100],
    base: 58, amp: 16, period: 57, noise: 1,
    warnLo: 10, warnHi: 95, critLo: 2, critHi: 99,
    states: ['open', 'closed'],
  },
  'ZS-502': {
    label: 'Belt position switch',
    unit: '',
    kind: 'discrete',
    states: ['made', 'clear'],
  },
  'SL-601': {
    label: 'Plant stack light',
    unit: '',
    kind: 'discrete',
    states: ['green', 'amber', 'red'],
  },
}

export const TAG_IDS = Object.keys(TAG_DEFS)

/** Tags a symbol can be bound to, in the order the tag strip lists them. */
export const ANALOG_TAG_IDS = TAG_IDS.filter((id) => TAG_DEFS[id].kind !== 'discrete')

const STATUS_RANK = { normal: 0, stale: 1, warn: 2, crit: 3 }

export function worseStatus(a, b) {
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function round(v, decimals) {
  if (v == null) return null
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

function analogStatus(def, value) {
  if (value == null) return 'normal'
  if (def.critLo != null && value <= def.critLo) return 'crit'
  if (def.critHi != null && value >= def.critHi) return 'crit'
  if (def.warnLo != null && value <= def.warnLo) return 'warn'
  if (def.warnHi != null && value >= def.warnHi) return 'warn'
  return 'normal'
}

/**
 * Small LCG so noise is reproducible within a session and does not depend on
 * Math.random's implementation. Seeded per tag id so two tags with identical
 * definitions still wander independently.
 */
function makeNoise(seedStr) {
  let s = 0
  for (let i = 0; i < seedStr.length; i += 1) s = (s * 31 + seedStr.charCodeAt(i)) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296 - 0.5
  }
}

/**
 * Creates a stateful simulator. `tick()` advances the plant one sample and
 * returns a fresh immutable snapshot (new object identity every tick, so
 * React re-renders; the arrays inside `history` are copied on write).
 */
export function createPlantSim() {
  const t0 = Date.now()
  const noise = {}
  TAG_IDS.forEach((id) => { noise[id] = makeNoise(id) })

  const history = {}
  ANALOG_TAG_IDS.forEach((id) => { history[id] = [] })

  let events = []
  let pulses = {}
  let prev = {}
  let excursion = null // { tag, until }

  TAG_IDS.forEach((id) => { pulses[id] = 0 })

  function pumpDuty(now) {
    // Lead/lag rotation: A runs, then B, then A… Exercises both the running
    // and the stopped steady-state animation without any operator input.
    return Math.floor((now - t0) / PUMP_SWAP_MS) % 2 === 0 ? 'A' : 'B'
  }

  function analogSample(id, elapsedSec) {
    const def = TAG_DEFS[id]
    const wave = Math.sin((elapsedSec / def.period) * Math.PI * 2) * def.amp
    const drift = Math.sin((elapsedSec / (def.period * 6.7)) * Math.PI * 2) * def.amp * 0.35
    return clamp(def.base + wave + drift + noise[id]() * def.noise * 2, def.range[0], def.range[1])
  }

  function tick() {
    const now = Date.now()
    const elapsedSec = (now - t0) / 1000
    if (excursion && now > excursion.until) excursion = null

    const duty = pumpDuty(now)
    const tags = {}
    const nextPulses = { ...pulses }
    const newEvents = []

    // --- pass 1: everything except the stack light (which summarises the rest)
    TAG_IDS.forEach((id) => {
      if (id === 'SL-601') return
      const def = TAG_DEFS[id]
      const before = prev[id]

      let state = null
      if (id === 'P-101A') state = duty === 'A' ? 'run' : 'stop'
      else if (id === 'P-101B') state = duty === 'B' ? 'run' : 'stop'
      else if (id === 'M-505' || id === 'CV-501') state = 'run'
      else if (id === 'XV-503') state = 'open'
      else if (id === 'ZS-502') state = Math.floor(elapsedSec / 4) % 3 === 0 ? 'made' : 'clear'

      let value = null
      if (def.kind !== 'discrete') {
        value = state === 'stop' ? 0 : analogSample(id, elapsedSec)
        if (excursion && excursion.tag === id) {
          value = clamp(def.critHi + def.range[1] * 0.02, def.range[0], def.range[1])
        }
      }

      // A stopped drive is off-duty, not a fault — do not alarm it.
      const status = state === 'stop' ? 'normal' : analogStatus(def, value)
      const display = round(value, def.decimals ?? 1)

      if (before) {
        const changed = def.kind === 'discrete'
          ? state !== before.state
          : display !== before.display || state !== before.state
        if (changed) nextPulses[id] += 1
        if (status !== before.status) {
          newEvents.push({ ts: now, tag: id, from: before.status, to: status })
        }
      }

      tags[id] = {
        id,
        label: def.label,
        unit: def.unit,
        kind: def.kind,
        decimals: def.decimals ?? 0,
        range: def.range ?? null,
        limits: {
          warnLo: def.warnLo ?? null,
          warnHi: def.warnHi ?? null,
          critLo: def.critLo ?? null,
          critHi: def.critHi ?? null,
        },
        value,
        prevValue: before ? before.value : value,
        display,
        prevDisplay: before ? before.display : display,
        state,
        status,
        prevStatus: before ? before.status : status,
        pulse: nextPulses[id],
        ts: now,
      }

      if (history[id]) {
        history[id] = history[id].concat([[now, value]])
        if (history[id].length > HISTORY_POINTS) {
          history[id] = history[id].slice(history[id].length - HISTORY_POINTS)
        }
      }
    })

    // --- pass 2: stack light mirrors the worst live status in the plant
    const worst = Object.values(tags).reduce((acc, t) => worseStatus(acc, t.status), 'normal')
    const beacon = worst === 'crit' ? 'red' : worst === 'warn' ? 'amber' : 'green'
    const slBefore = prev['SL-601']
    if (slBefore && slBefore.state !== beacon) {
      nextPulses['SL-601'] += 1
      newEvents.push({ ts: now, tag: 'SL-601', from: slBefore.status, to: worst })
    }
    tags['SL-601'] = {
      id: 'SL-601',
      label: TAG_DEFS['SL-601'].label,
      unit: '',
      kind: 'discrete',
      decimals: 0,
      range: null,
      limits: { warnLo: null, warnHi: null, critLo: null, critHi: null },
      value: null,
      prevValue: null,
      display: null,
      prevDisplay: null,
      state: beacon,
      status: worst,
      prevStatus: slBefore ? slBefore.status : worst,
      pulse: nextPulses['SL-601'],
      ts: now,
    }

    if (newEvents.length) {
      events = newEvents.reverse().concat(events).slice(0, EVENT_LOG_SIZE)
    }
    pulses = nextPulses
    prev = tags

    return {
      tags,
      history: { ...history },
      events,
      ts: now,
      running: true,
      excursionTag: excursion ? excursion.tag : null,
    }
  }

  function excite(tagId, ms = EXCURSION_MS) {
    if (!TAG_DEFS[tagId] || TAG_DEFS[tagId].critHi == null) return
    excursion = { tag: tagId, until: Date.now() + ms }
  }

  return { tick, excite }
}

/** Formats a tag's live number for a readout. Never returns undefined. */
export function formatValue(tag) {
  if (!tag) return '—'
  if (tag.display == null) return tag.state ? tag.state.toUpperCase() : '—'
  return tag.display.toFixed(tag.decimals)
}

/** True when a drive/flow tag is actively moving product. */
export function isFlowing(tag) {
  if (!tag) return true
  if (tag.state) return tag.state !== 'stop' && tag.state !== 'closed'
  return tag.value == null || tag.value > 0
}
