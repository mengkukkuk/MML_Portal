/**
 * kpiBoxes — the headline numbers above the drawing.
 *
 * A mimic answers "what is this plant doing right now" symbol by symbol. The
 * strip answers the question a shift leader asks from the doorway: the two or
 * three figures that decide whether the line is having a good day. They are
 * deliberately *not* derived from the hourly production log below them — a box
 * may just as well carry line speed or oven temperature — so each one is its
 * own binding, read exactly the way every symbol on the sheet is read.
 *
 * ## The binding is stored in the poller's own shape
 *
 * `binding` here is the same flat snake_case object a node carries, because
 * that is literally what `useMimicPlant`'s `argsOf` consumes. A box therefore
 * joins the existing poll round as a pseudo-node instead of opening a second
 * clock on the page, and inherits the cadence control, the stale rule and the
 * source-health report for nothing. Keep the two shapes identical: the moment
 * they diverge, the strip needs a poller of its own.
 *
 * Presentation (`unit`, `decimals`, `expr`) rides inside the binding for the
 * same reason — `deriveTag` already reads those three off `node.binding` and
 * hands back an entry the strip can print without knowing anything else.
 */

/**
 * Six boxes, and the cap is about reading rather than storage.
 *
 * The strip's whole value is being legible from across a control room. A
 * seventh box does not add a seventh number so much as shrink the other six.
 */
export const KPI_LIMIT = 6

/** Matches the repo's node/edge id convention: prefix, base36 clock, counter. */
let addCounter = 0
export function newKpiId() {
  addCounter += 1
  return `kpi-${Date.now().toString(36)}-${addCounter}`
}

/** A box with nothing bound yet — added by the `+` slot, configured after. */
export function blankKpi() {
  return {
    id: newKpiId(),
    label: '',
    labelEn: '',
    binding: null,
  }
}

/** True once this box points at something the poller can actually read. */
export function kpiIsBound(kpi) {
  return !!(kpi?.binding?.table && kpi?.binding?.value_col)
}

/** The fields a box is allowed to carry, and nothing else. */
function cleanKpi(kpi, id) {
  return {
    id,
    label: typeof kpi.label === 'string' ? kpi.label : '',
    labelEn: typeof kpi.labelEn === 'string' ? kpi.labelEn : '',
    binding: kpi.binding ?? null,
  }
}

/**
 * Whatever the document held, repaired into a list this build can render.
 *
 * Ids are load-bearing rather than cosmetic: they key the poller's readings, so
 * a duplicate would make two boxes show one number and a missing one would make
 * a box show whatever its neighbour last read. A document written by hand, or
 * by an older build that had no ids at all, is repaired rather than rejected —
 * the strip is not worth locking a plant drawing over.
 *
 * **This mints ids, so it belongs at a document boundary and nowhere else** —
 * `migrateLayout`, which runs once per load, save, import and revision reload.
 * Called on every render instead it would hand a malformed box a *fresh* id
 * each time the layout object changed, which moves the poller's query key and
 * throws away that box's accumulated history every time an admin nudges an
 * unrelated symbol. Repairs would also never reach the document, so it would
 * repair forever. To read a document, use `readKpis`.
 */
export function normalizeKpis(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  return list
    .filter((kpi) => kpi && typeof kpi === 'object')
    .slice(0, KPI_LIMIT)
    .map((kpi) => {
      const id = typeof kpi.id === 'string' && kpi.id && !seen.has(kpi.id)
        ? kpi.id
        : newKpiId()
      seen.add(id)
      return cleanKpi(kpi, id)
    })
}

/**
 * The same list, read rather than repaired — pure, and safe on every render.
 *
 * Identical output to `normalizeKpis` for any document that came through
 * `migrateLayout`, which is every document the page ever holds. The difference
 * is what it does with the ones that did not: a box with no usable id is
 * dropped instead of being given one, because minting here is what would make
 * the render path non-deterministic.
 */
export function readKpis(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  list.forEach((kpi) => {
    if (!kpi || typeof kpi !== 'object') return
    const { id } = kpi
    if (typeof id !== 'string' || !id || seen.has(id)) return
    seen.add(id)
    if (out.length < KPI_LIMIT) out.push(cleanKpi(kpi, id))
  })
  return out
}

/**
 * The strip's bindings, dressed as nodes so the plant poller will take them.
 *
 * Only bound boxes are emitted. An unbound one has nothing to ask for, and
 * including it would count against the "every binding came back empty" test
 * that decides whether the page declares the plant unreachable — one box an
 * admin added and has not filled in yet must never do that.
 *
 * `type` is deliberately absent. `deriveTag` looks the symbol up to decide
 * whether a tag is analog or discrete and falls back to analog when there is no
 * symbol, which is exactly right for a printed number.
 */
export function kpiPollNodes(kpis) {
  return (kpis ?? [])
    .filter(kpiIsBound)
    .map((kpi) => ({ id: kpi.id, label: kpi.label || kpi.id, binding: kpi.binding }))
}
