/**
 * Pure edits to a mimic layout document — `(doc, …args) => doc`.
 *
 * These are the bodies that used to sit inside MonitorPage's `useCallback`s.
 * They are meant to be handed to the editor session's `commit` / `preview`
 * (which pass the *current draft*, not the rendered one), so a burst of key
 * repeats accumulates instead of collapsing to the last one. Pure, so they are
 * unit-tested apart from React (layoutOps.test.js).
 */
import { clamp, moveGroup } from './editorSelection.js'
import { sheetOf } from './sheet.js'

export const PASTE_OFFSET = 24
const SNAP_UNIT = 8

// Shared by nodes and edges so two ids minted in the same millisecond differ.
let sequence = 0
const mintId = (prefix) => {
  sequence += 1
  return `${prefix}-new-${Date.now().toString(36)}-${sequence}`
}
export const newNodeId = () => mintId('n')
export const newEdgeId = () => mintId('e')

const mapNode = (doc, id, fn) => ({
  ...doc,
  nodes: doc.nodes.map((n) => (n.id === id ? fn(n) : n)),
})

/** Shallow-merge `patch` into one node (move / resize / bubble all use this). */
export const patchNode = (doc, id, patch) => mapNode(doc, id, (n) => ({ ...n, ...patch }))

/** Write a group's already-computed positions, one `{ id, x, y }` per member. */
export function moveNodesTo(doc, updates) {
  const at = new Map(updates.map((u) => [u.id, u]))
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (at.has(n.id) ? { ...n, x: at.get(n.id).x, y: at.get(n.id).y } : n)),
  }
}

export function nudgeNode(doc, id, dx, dy) {
  const sheet = sheetOf(doc)
  return mapNode(doc, id, (n) => ({
    ...n,
    x: clamp(n.x + dx, 0, sheet.w - n.w),
    y: clamp(n.y + dy, 0, sheet.h - n.h),
  }))
}

/** One delta for the whole group, limited by the members nearest each edge. */
export function nudgeNodes(doc, ids, dx, dy) {
  const members = doc.nodes.filter((n) => ids.includes(n.id))
  if (!members.length) return doc
  return moveNodesTo(doc, moveGroup(members, dx, dy, sheetOf(doc)))
}

/** Deleting a node takes its wires with it — an edge with no endpoint has no geometry. */
export function removeNodes(doc, ids) {
  const gone = new Set(ids)
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !gone.has(n.id)),
    edges: doc.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node)),
  }
}

/** Merge `patch` into the appearance options of every node in `ids`. */
export const patchNodesOptions = (doc, ids, patch) => ({
  ...doc,
  nodes: doc.nodes.map((n) => (ids.includes(n.id) ? { ...n, options: { ...n.options, ...patch } } : n)),
})

export const patchNodeOptions = (doc, id, patch) => patchNodesOptions(doc, [id], patch)

/** Degrees, normalised so a rotated symbol reports 15° rather than 375°. */
export const rotateNode = (doc, id, deg) => (
  patchNode(doc, id, { rot: ((Math.round(deg) % 360) + 360) % 360 })
)

/**
 * Back to the size the symbol was drawn at. Position is left alone. `sizeOf`
 * resolves a node's default `{ w, h }` (the symbol registry, which this module
 * deliberately does not import).
 */
export const resetNodeSize = (doc, id, sizeOf) => (
  mapNode(doc, id, (n) => ({ ...n, ...(sizeOf(n) ?? { w: n.w, h: n.h }) }))
)

export const setBubbleOffset = (doc, id, offset) => patchNode(doc, id, { bubble: { offset } })
export const clearBubble = (doc, id) => patchNode(doc, id, { bubble: null })

export const patchTheme = (doc, patch) => ({ ...doc, theme: { ...(doc.theme ?? {}), ...patch } })

export const setSheetSize = (doc, w, h) => ({ ...doc, viewBox: { w, h } })

/** A copy of `copied`, shifted by `PASTE_OFFSET * pasteIndex` and kept on the sheet. */
export function buildPastedNode(copied, sheet, pasteIndex) {
  const offset = PASTE_OFFSET * pasteIndex
  return {
    ...structuredClone(copied),
    id: newNodeId(),
    x: clamp(copied.x + offset, 0, sheet.w - copied.w),
    y: clamp(copied.y + offset, 0, sheet.h - copied.h),
  }
}

/**
 * A fresh, unbound node centred on `point` (default: the middle of the sheet).
 * `symbolId` only matters for `custom`; it has to be on the node from the moment
 * it is created because size and ports come off that library entry.
 */
export function buildNewNode({ def, type, symbolId = null, point = null, sheet, snap }) {
  const rawX = (point?.x ?? sheet.w / 2) - def.defaultSize.w / 2
  const rawY = (point?.y ?? sheet.h / 2) - def.defaultSize.h / 2
  const place = (value) => (snap ? Math.round(value / SNAP_UNIT) * SNAP_UNIT : Math.round(value))
  return {
    id: newNodeId(),
    type,
    ...(symbolId == null ? {} : { symbolId }),
    tagId: null,
    binding: null,
    label: def.label,
    x: clamp(place(rawX), 0, sheet.w - def.defaultSize.w),
    y: clamp(place(rawY), 0, sheet.h - def.defaultSize.h),
    w: def.defaultSize.w,
    h: def.defaultSize.h,
    rot: 0,
  }
}

/**
 * The wire already joining these two ports in either direction, if any.
 * Direction is a drawing choice, not a fact about the plant.
 */
export function findParallelEdge(edges, from, to) {
  return edges.find((e) => (
    (e.from.node === from.node && e.from.port === from.port
      && e.to.node === to.node && e.to.port === to.port)
    || (e.from.node === to.node && e.from.port === to.port
      && e.to.node === from.node && e.to.port === from.port)
  ))
}

export const buildEdge = (from, to, service) => ({
  id: newEdgeId(), from, to: { node: to.node, port: to.port }, service, flowNode: null,
})
