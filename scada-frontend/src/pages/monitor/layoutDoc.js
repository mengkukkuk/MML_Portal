import { SYMBOLS } from '@/components/mimic/symbols'
import { cloneDefaultLayout, LAYOUT_VERSION } from './defaultLayout'

/**
 * layoutDoc — validation, migration and the one-time localStorage handover.
 *
 * The drawing now lives in Postgres (`mimic_layouts`, via src/api/mimic.js).
 * This module is what stands between a stored document and the renderer: a
 * doc written by an older build must not reach code that assumes the current
 * shape.
 *
 * v1 → v2 is exactly the binding split. v1 nodes carried a single `tag`
 * string that was doing two jobs at once — the key into the simulator's
 * dictionary *and* the loop number printed in the ISA balloon. v2 keeps the
 * printed part as `tagId` and adds `binding`, the real datasource pointer.
 * v1 edges named their flow tag the same way, so `flowTag` becomes
 * `flowNode`, a node id, matching the snapshot's new node-keyed shape.
 *
 * A document this build cannot *fully* draw is still returned. Discarding one
 * used to mean the caller fell back to its seed, which showed the operator a
 * different plant under the right name and let the next save overwrite the real
 * drawing with that seed. So the rule here is: keep whatever can be rendered,
 * and report what is wrong with it through `editLock` so the caller can go
 * read-only instead of silently substituting.
 */

const LEGACY_KEY = 'mml.mimic.boiler-1'

/**
 * Structural check only — enough to know the renderer won't throw.
 *
 * Deliberately *not* a check that every symbol type is drawable: that is a fact
 * about this bundle's age, not about the document, and it is reported by
 * `unknownTypes` rather than used to reject the whole drawing.
 */
export function isRenderable(doc) {
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return false
  return doc.nodes.every((n) => (
    n && typeof n.id === 'string'
      && Number.isFinite(n.x) && Number.isFinite(n.y)
      && Number.isFinite(n.w) && Number.isFinite(n.h)
  ))
}

/**
 * Symbol types in this document that this bundle has no renderer for, once.
 *
 * A `custom` node counts as known: the *type* is registered, and a library
 * entry that has not arrived yet is a loading state the canvas draws as a
 * placeholder — not a reason to lock the drawing.
 */
export function unknownTypes(doc) {
  const seen = []
  ;(doc?.nodes ?? []).forEach((n) => {
    if (!SYMBOLS[n.type] && !seen.includes(n.type)) seen.push(n.type)
  })
  return seen
}

/** True when the document was written by a build newer than this one. */
export function isFutureVersion(doc) {
  return (doc?.version ?? 1) > LAYOUT_VERSION
}

/**
 * Why this drawing may not be edited, or null when it may.
 *
 * Editing is all-or-nothing: the PUT replaces the whole document, so an admin
 * who saves a drawing this bundle only partly understands writes their partial
 * understanding over everyone else's plant. One call answers both questions the
 * page has — whether to warn, and whether to offer the Edit button — so the two
 * can never disagree.
 */
export function editLock(doc) {
  if (!doc) return null
  if (isFutureVersion(doc)) {
    return 'This drawing was saved by a newer version of the app. It is shown '
      + 'read-only so an edit here cannot overwrite what that version stored.'
  }
  const unknown = unknownTypes(doc)
  if (unknown.length > 0) {
    return `This build has no symbol for ${unknown.join(', ')}. The drawing is `
      + 'shown read-only — those symbols appear as placeholders, and saving would '
      + 'discard them. Update the frontend to edit it.'
  }
  return null
}

/**
 * Bring any older document up to the current shape. Geometry is preserved
 * exactly — an admin's hand-arranged drawing must survive the upgrade — and
 * every migrated node comes back unbound, because a v1 doc never had a real
 * datasource to point at in the first place.
 *
 * Returns null only when the document is too broken to render at all. A doc
 * from a newer build comes back untouched: it may carry fields this bundle
 * ignores, but showing the plant and refusing to save it beats showing a
 * different plant.
 */
export function migrateLayout(doc) {
  if (!doc || !Array.isArray(doc.nodes)) return null

  let out = doc
  if ((doc.version ?? 1) < 2) {
    out = {
      ...doc,
      version: 2,
      name: doc.name ?? 'Boiler House 1',
      nodes: doc.nodes.map(({ tag, ...node }) => ({
        ...node,
        tagId: node.tagId ?? tag ?? null,
        binding: node.binding ?? null,
      })),
      edges: (doc.edges ?? []).map(({ flowTag, ...edge }) => ({
        ...edge,
        // A v1 flowTag named a simulator tag; the node that carried it is the
        // closest true equivalent, and only a same-id node can be recovered.
        flowNode: edge.flowNode
          ?? (flowTag ? doc.nodes.find((n) => n.tag === flowTag)?.id ?? null : null),
      })),
    }
  }

  if ((out.version ?? 2) < 3) {
    out = {
      ...out,
      version: 3,
      productionLog: out.productionLog ?? null,
    }
  }

  return isRenderable(out) ? out : null
}

/**
 * The admin's pre-server drawing, if there is one.
 *
 * /monitor kept its layout in localStorage before `mimic_layouts` existed.
 * Read it once, when the server has no row yet, so hand-placed geometry is
 * carried into the first server save instead of being silently replaced by
 * the seed. Never throws.
 */
export function readLegacyLayout() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    return migrateLayout(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Drop the legacy key once its content is safely on the server. */
export function clearLegacyLayout() {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch { /* private mode — nothing to clean up */ }
}

/** A fresh, uncommissioned drawing — the seeded boiler skid. */
export function seedLayout() {
  return cloneDefaultLayout()
}

/**
 * A brand-new mimic: a blank sheet.
 *
 * Deliberately *not* seedLayout(). The seed is one specific plant, and a
 * drawing someone just named "Water Treatment" should not open onto a boiler
 * whose seventeen symbols have to be deleted before any real work starts.
 */
export function emptyLayout(name) {
  return {
    version: LAYOUT_VERSION,
    name,
    viewBox: { w: 1600, h: 900 },
    nodes: [],
    edges: [],
    productionLog: null,
  }
}
