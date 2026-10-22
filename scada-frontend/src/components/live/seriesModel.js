/**
 * seriesModel — which series a Live panel draws, derived from its binding.
 *
 * One pure function shared by the tile (usePanelSeries), the grid's minimum-size
 * estimate (panelPayload.seriesCount) and the editor (unit / gauge / condition
 * keys), so the three can never disagree about how many lines a panel has or
 * what each is called.
 *
 * Three options widen the original "value column x series value" product:
 *
 * - `unsplitCols`: a value column drawn once, not repeated per series value. It
 *   reads the whole table (no filter), so it suits a column that holds the same
 *   value on every row.
 * - `arraySlots`: `{ [column]: [{ index, name? }] }`. An array column draws one
 *   line per listed slot. Absent means slot 0 alone, and then the series is
 *   identical to what it was before this option existed -- same key, same label
 *   -- so saved panels are untouched.
 * - `textCols`: columns that hold words. Their series is flagged `isText`; the
 *   tile prints the latest word instead of plotting.
 *
 * Kept free of the `@/` alias so node's test runner can import it.
 */

export const DEFAULT_SLOTS = [{ index: 0 }]

/** Name of one slot as alert conditions and unit maps refer to it: `reading[2]`. */
export const slotKey = (col, index) => `${col}[${index}]`

/** Slots, whole-number indexes only, one per index, ascending, names trimmed. */
export function cleanSlots(slots) {
  const byIndex = new Map()
  for (const s of slots || []) {
    const index = Number(s?.index)
    if (!Number.isInteger(index) || index < 0) continue
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    byIndex.set(index, name ? { index, name } : { index })
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/** The slots a column draws: its saved list, or slot 0 when it has none. */
export function slotsOf(arraySlots, col) {
  const cleaned = cleanSlots(arraySlots?.[col])
  return cleaned.length ? cleaned : DEFAULT_SLOTS
}

/** True for the legacy "slot 0, unnamed" selection that needs no saved entry. */
export function isDefaultSlots(slots) {
  const cleaned = cleanSlots(slots)
  return cleaned.length === 0 || (cleaned.length === 1 && cleaned[0].index === 0 && !cleaned[0].name)
}

/**
 * Keep only entries worth saving: bound columns, non-default selections.
 * Returns `undefined`-free plain data (an empty object when nothing is left).
 */
export function pruneArraySlots(arraySlots, boundCols) {
  const out = {}
  const bound = new Set(boundCols)
  for (const [col, slots] of Object.entries(arraySlots || {})) {
    if (!bound.has(col) || isDefaultSlots(slots)) continue
    out[col] = cleanSlots(slots)
  }
  return out
}

/**
 * Every series a binding draws, in draw order (column, then slot, then series
 * value). `filters` is whatever the caller wants fetched -- the tile passes the
 * viewer's override when set.
 *
 * Returns `[{ key, label, valueCol, filterVal, slot, isText, unsplit,
 * unitKey, varName }]`:
 *  - `key`      stable identity (`[col, filter]`, plus the slot when mapped)
 *  - `unitKey`  where its unit / gauge override / display name is stored
 *  - `varName`  how an alert condition names it
 *  - `slot`     array index to read, or `null` for a scalar column
 *  - `unsplit`  drawn once although a series column is set
 */
export function deriveSeriesSpecs({
  metric, valueCols = [], filterCol = null, filters = [],
  unsplitCols = [], arraySlots = {}, columnLabels = {}, textCols = [],
}) {
  const cols = [metric, ...(valueCols || [])].filter(Boolean)
  const hasFilter = !!filterCol && (filters || []).length > 0
  const unsplitSet = new Set(unsplitCols || [])
  const textSet = new Set(textCols || [])
  const multiCol = cols.length > 1
  const nameFor = (k) => (columnLabels && columnLabels[k]) || k

  const specs = []
  for (const vc of cols) {
    const split = hasFilter && !unsplitSet.has(vc)
    const fvs = split ? filters : [null]
    const slots = slotsOf(arraySlots, vc)
    const mapped = !isDefaultSlots(arraySlots?.[vc])
    for (const slot of mapped ? slots : [null]) {
      for (const fv of fvs) {
        const index = slot ? slot.index : null
        const key = JSON.stringify(mapped ? [vc, fv, index] : [vc, fv])
        const spec = {
          key,
          valueCol: vc,
          filterVal: fv,
          slot: index,
          isText: textSet.has(vc),
          unsplit: hasFilter && !split,
        }
        if (mapped) {
          const base = slot.name || `${nameFor(vc)} [${index}]`
          spec.unitKey = slotKey(vc, index)
          spec.varName = slotKey(vc, index)
          spec.label = fv != null ? `${base} · ${nameFor(fv)}` : base
        } else {
          spec.unitKey = fv != null ? fv : vc
          spec.varName = vc
          spec.label = multiCol && fv != null
            ? `${nameFor(vc)} · ${nameFor(fv)}`
            : nameFor(spec.unitKey)
        }
        specs.push(spec)
      }
    }
  }
  return specs
}

/** Read one slot out of a reading. A scalar answers only for slot 0 / no slot. */
export function pickSlot(value, slot) {
  if (Array.isArray(value)) return value[slot ?? 0] ?? null
  return slot ? null : value
}

/**
 * Group specs by what has to be asked of the server: one read per
 * (column, series value), however many slots draw from it.
 * Returns `[{ valueCol, filterVal, members: spec[] }]`.
 */
export function groupBySource(specs) {
  const groups = new Map()
  for (const s of specs) {
    const id = JSON.stringify([s.valueCol, s.filterVal])
    let g = groups.get(id)
    if (!g) { g = { valueCol: s.valueCol, filterVal: s.filterVal, members: [] }; groups.set(id, g) }
    g.members.push(s)
  }
  return [...groups.values()]
}

/** Chart types that draw a line / bar / dial and so need a number. */
export const TEXT_FRIENDLY_TYPES = new Set(['stat', 'table'])

/** Whether a chart type has anything to draw from these specs. */
export function hasPlottableSeries(chartType, specs) {
  if (TEXT_FRIENDLY_TYPES.has(chartType)) return specs.length > 0
  return specs.some((s) => !s.isText)
}
