import { useCallback } from 'react'
import { SYMBOLS, symbolDef } from '@/components/mimic/symbols'
import * as ops from '../layoutOps'
import { sheetOf } from '../sheet'

/**
 * Every edit the editor can make to the drawing, as callbacks for the canvas,
 * the inspectors and the command bar.
 *
 * The document maths lives in layoutOps.js; this hook only wires it to the
 * editor session — `previewLayout` for a drag in progress (not an undo step
 * until the gesture ends), `commitLayout` for a finished edit — and to the
 * selection that an edit may change.
 *
 * Resolved against the draft passed to the updater rather than the rendered one
 * so a burst of key repeats accumulates instead of collapsing to the last one.
 */
export default function useLayoutEdits({
  layout, commitLayout, previewLayout, selection, notify, snapEnabled, wirePen, setWirePen,
}) {
  const {
    selectedId, selectedEdgeId, selectedNode,
    selectNode, selectEdge, setSelectedId, setSelectedEdgeId, setGroupIds, nextPaste,
  } = selection

  // --- geometry edits ------------------------------------------------------
  const moveNode = useCallback((id, pos) => {
    previewLayout((prev) => ops.patchNode(prev, id, pos))
  }, [previewLayout])

  const nudgeNode = useCallback((id, dx, dy) => {
    commitLayout((prev) => ops.nudgeNode(prev, id, dx, dy))
  }, [commitLayout])

  // --- group edits ---------------------------------------------------------
  // The canvas computes the group's positions (a rigid block, clamped as one);
  // these only write them, through the same preview/commit path as one symbol,
  // so a group move is one undo step.
  const moveNodes = useCallback((updates) => {
    previewLayout((prev) => ops.moveNodesTo(prev, updates))
  }, [previewLayout])

  const nudgeNodes = useCallback((ids, dx, dy) => {
    commitLayout((prev) => ops.nudgeNodes(prev, ids, dx, dy))
  }, [commitLayout])

  const deleteNodes = useCallback((ids) => {
    commitLayout((prev) => ops.removeNodes(prev, ids))
    setGroupIds([])
    setSelectedId(null)
    setSelectedEdgeId(null)
  }, [commitLayout, setGroupIds, setSelectedEdgeId, setSelectedId])

  const setNodesOptions = useCallback((ids, patch) => {
    commitLayout((prev) => ops.patchNodesOptions(prev, ids, patch))
  }, [commitLayout])

  // Sheet size. Growing is always safe; shrinking is only offered when every
  // symbol still fits (see sheetFits), so nothing is ever left off the sheet.
  const setSheetSize = useCallback((w, h) => {
    commitLayout((prev) => ops.setSheetSize(prev, w, h))
  }, [commitLayout])

  // Ports are fractions of the node box and edge geometry is never stored, so
  // a resize re-routes every wire on the symbol for free. The canvas has
  // already snapped and clamped the box.
  const resizeNode = useCallback((id, box) => {
    previewLayout((prev) => ops.patchNode(prev, id, box))
  }, [previewLayout])

  // Rotation was already wired end to end on the canvas — the transform is
  // applied and resizeBox un-rotates pointer deltas — with nothing to set it.
  const rotateNode = useCallback((id, deg) => {
    commitLayout((prev) => ops.rotateNode(prev, id, deg))
  }, [commitLayout])

  /**
   * Merge a patch into one symbol's appearance options.
   *
   * Merged rather than replaced so each control in the inspector can send only
   * the key it owns — the alarm tile's severity select must not have to
   * remember and resend the condition beside it.
   *
   * The bag itself is untyped here on purpose. `mimic.py` stores unknown node
   * keys as-is, so a symbol growing an option stays a pure frontend change, the
   * same way a symbol growing a *type* already is.
   */
  const setNodeOptions = useCallback((id, patch) => {
    commitLayout((prev) => ops.patchNodeOptions(prev, id, patch))
  }, [commitLayout])

  // Drawing-wide symbol colours (colour by category, per-category colour).
  // Stored on the layout document as `theme`; the server keeps it untouched.
  const setLayoutTheme = useCallback((patch) => {
    commitLayout((prev) => ops.patchTheme(prev, patch))
  }, [commitLayout])

  // Back to the size the symbol was drawn at. Position is left alone: the
  // symbol is where the engineer put it, and only its size was in question.
  const resetNodeSize = useCallback((id) => {
    commitLayout((prev) => ops.resetNodeSize(prev, id, (n) => symbolDef(n)?.defaultSize))
  }, [commitLayout])

  const deleteNode = useCallback((id) => {
    commitLayout((prev) => ops.removeNodes(prev, [id]))
    setSelectedId(null)
    // One of the pipes that just went with it may have been the selection.
    setSelectedEdgeId(null)
  }, [commitLayout, setSelectedEdgeId, setSelectedId])

  // --- balloon placement ---------------------------------------------------
  // Stored as an offset from the symbol's own anchor, so a repositioned
  // reading follows its equipment the next time that equipment is dragged.
  const moveBubble = useCallback((id, offset) => {
    previewLayout((prev) => ops.setBubbleOffset(prev, id, offset))
  }, [previewLayout])

  const resetBubble = useCallback((id) => {
    commitLayout((prev) => ops.clearBubble(prev, id))
  }, [commitLayout])

  // --- wiring --------------------------------------------------------------
  const addEdge = useCallback((from, to) => {
    if (from.node === to.node) {
      notify('A wire runs between two different symbols.', 'warning')
      return
    }
    // Direction is a drawing choice, not a fact about the plant, so a wire
    // drawn back the other way is the same wire — select it rather than
    // stacking a second line on the identical route.
    const existing = ops.findParallelEdge(layout.edges, from, to)
    if (existing) {
      selectEdge(existing.id)
      notify('These ports are already connected.', 'info')
      return
    }
    const edge = ops.buildEdge(from, to, wirePen)
    commitLayout((prev) => ({ ...prev, edges: [...prev.edges, edge] }))
    selectEdge(edge.id)
  }, [commitLayout, layout, notify, selectEdge, wirePen])

  // Correcting one wire's type in the inspector also picks up the pen: you
  // reached for that line because it was the one you meant, and the next
  // segment of the same run almost always wants it too.
  const updateEdge = useCallback((id, patch) => {
    if (patch.service) setWirePen(patch.service)
    commitLayout((prev) => ({
      ...prev,
      edges: prev.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))
  }, [commitLayout, setWirePen])

  const deleteEdge = useCallback((id) => {
    commitLayout((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== id) }))
    setSelectedEdgeId(null)
  }, [commitLayout, setSelectedEdgeId])

  // --- adding symbols ------------------------------------------------------
  /**
   * Drop a new symbol at `point`, or the centre of the sheet.
   *
   * `symbolId` names a library entry and is only meaningful for `custom`. It has
   * to be on the node from the moment it is created — the size and ports come off
   * that entry, so a custom node without one would be placed at the generic
   * fallback size and then jump when it resolved.
   */
  const addSymbol = useCallback((type, symbolId = null, point = null) => {
    const def = symbolDef({ type, symbolId }) ?? SYMBOLS[type]
    const node = ops.buildNewNode({
      def, type, symbolId, point, sheet: sheetOf(layout), snap: snapEnabled,
    })
    commitLayout((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    selectNode(node.id)
  }, [commitLayout, layout, selectNode, snapEnabled])

  const pasteSymbol = useCallback(() => {
    const paste = nextPaste()
    if (!paste) return false
    const node = ops.buildPastedNode(paste.node, sheetOf(layout), paste.index)
    commitLayout((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    selectNode(node.id)
    return true
  }, [commitLayout, layout, nextPaste, selectNode])

  // --- acting on the current selection --------------------------------------
  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) deleteEdge(selectedEdgeId)
    else if (selectedId) deleteNode(selectedId)
  }, [deleteEdge, deleteNode, selectedEdgeId, selectedId])

  const rotateSelection = useCallback(() => {
    if (selectedNode) rotateNode(selectedNode.id, (selectedNode.rot || 0) + 90)
  }, [rotateNode, selectedNode])

  return {
    moveNode, nudgeNode, moveNodes, nudgeNodes, deleteNodes, setNodesOptions, setSheetSize,
    resizeNode, rotateNode, setNodeOptions, setLayoutTheme, resetNodeSize, deleteNode,
    moveBubble, resetBubble, addEdge, updateEdge, deleteEdge, addSymbol, pasteSymbol,
    deleteSelection, rotateSelection,
  }
}
