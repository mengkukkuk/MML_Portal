import { useCallback, useRef, useState } from 'react'

/**
 * What is selected on the drawing, and the copy buffer.
 *
 * A symbol and a pipe are never selected at once: the rail shows one
 * inspector, so two selections would leave one of them unreachable. A box or
 * shift selection of two or more symbols (editor only) is `groupIds`, mutually
 * exclusive with `selectedId`: one symbol is the inspector's, several are the
 * group panel's.
 *
 * `onReveal` is called after any selection, so the editor can bring the
 * inspector forward on a narrow screen.
 */
export default function useMimicSelection({
  nodes, edges, tags, onReveal,
}) {
  const [selectedId, setSelectedId] = useState(null)
  const [groupIds, setGroupIds] = useState([])
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const copiedNodeRef = useRef(null)
  const pasteCountRef = useRef(0)

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null
  const selectedTag = selectedId ? tags[selectedId] ?? null : null

  const selectNode = useCallback((id) => {
    setSelectedId(id)
    setGroupIds([])
    setSelectedEdgeId(null)
    onReveal()
  }, [onReveal])

  const selectEdge = useCallback((id) => {
    setSelectedEdgeId(id)
    setSelectedId(null)
    setGroupIds([])
    onReveal()
  }, [onReveal])

  // Several at once: none clears, one is an ordinary selection, more is a group.
  const selectMany = useCallback((ids) => {
    const unique = [...new Set(ids)]
    if (unique.length <= 1) {
      selectNode(unique[0] ?? null)
      return
    }
    setGroupIds(unique)
    setSelectedId(null)
    setSelectedEdgeId(null)
    onReveal()
  }, [onReveal, selectNode])

  const copySelection = useCallback(() => {
    if (!selectedNode) return false
    copiedNodeRef.current = structuredClone(selectedNode)
    pasteCountRef.current = 0
    return true
  }, [selectedNode])

  /** The copied node and which paste this is (1, 2, …), or null if nothing was copied. */
  const nextPaste = useCallback(() => {
    if (!copiedNodeRef.current) return null
    pasteCountRef.current += 1
    return { node: copiedNodeRef.current, index: pasteCountRef.current }
  }, [])

  const resetClipboard = useCallback(() => {
    copiedNodeRef.current = null
    pasteCountRef.current = 0
  }, [])

  return {
    selectedId, setSelectedId,
    groupIds, setGroupIds,
    selectedEdgeId, setSelectedEdgeId,
    selectedNode, selectedEdge, selectedTag,
    selectNode, selectEdge, selectMany,
    copySelection, nextPaste, resetClipboard,
  }
}
