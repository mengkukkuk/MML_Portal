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
 */

const LEGACY_KEY = 'mml.mimic.boiler-1'

/** Structural check only — enough to know the renderer won't throw. */
export function isRenderable(doc) {
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return false
  return doc.nodes.every((n) => (
    n && typeof n.id === 'string' && SYMBOLS[n.type]
      && Number.isFinite(n.x) && Number.isFinite(n.y)
      && Number.isFinite(n.w) && Number.isFinite(n.h)
  ))
}

/**
 * Bring any older document up to the current shape. Geometry is preserved
 * exactly — an admin's hand-arranged drawing must survive the upgrade — and
 * every migrated node comes back unbound, because a v1 doc never had a real
 * datasource to point at in the first place.
 *
 * Returns null when the document is too broken to render, so the caller can
 * fall back to the seed rather than draw a hole.
 */
export function migrateLayout(doc) {
  if (!doc || !Array.isArray(doc.nodes)) return null

  const version = doc.version ?? 1
  if (version > LAYOUT_VERSION) return null // written by a newer build

  let out = doc
  if (version < 2) {
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

/** A fresh, uncommissioned drawing. */
export function seedLayout() {
  return cloneDefaultLayout()
}
