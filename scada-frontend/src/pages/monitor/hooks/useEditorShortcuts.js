import { useEffect } from 'react'

/** Keys typed into a field or dialog belong to it, not to the drawing. */
const typingInto = (event) => (
  event.target instanceof Element
  && !!event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
)

/** A bare key press — no modifier, nothing else has claimed it, not typing. */
const isPlainKey = (event, key) => (
  !event.defaultPrevented
  && !event.ctrlKey && !event.metaKey && !event.altKey
  && event.key.toLowerCase() === key
  && !typingInto(event)
)

/**
 * The page's window-level keyboard shortcuts.
 *
 *  - Edit mode: Ctrl/Cmd+S save, C/V copy/paste, Z/Y undo/redo, Delete, arrows nudge.
 *  - View mode: H toggles the hand tool.
 *  - Both: F toggles full screen. Esc leaves — the browser insists on that and
 *    says so, so there is nothing here to hold it open.
 *  - Esc also closes the production-log drawer.
 */
export default function useEditorShortcuts({
  editing, layout, dirty, saving, handleSave,
  copySelection, pasteSymbol, undoLayout, redoLayout, deleteSelection, nudgeNode,
  selectedId, selectedEdgeId,
  productionLogOpen, setProductionLogOpen, setViewPan, toggleFullscreen,
}) {
  useEffect(() => {
    if (!editing) return undefined
    const shortcut = (event) => {
      if (saving) return
      if (event.defaultPrevented) return
      if (typingInto(event)) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (dirty && !saving) handleSave()
      } else if (mod && event.key.toLowerCase() === 'c') {
        if (copySelection()) event.preventDefault()
      } else if (mod && event.key.toLowerCase() === 'v') {
        if (pasteSymbol()) event.preventDefault()
      } else if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoLayout()
        else undoLayout()
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redoLayout()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedId && !selectedEdgeId) return
        event.preventDefault()
        deleteSelection()
      } else if (selectedId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const step = event.shiftKey ? 1 : 8
        const [dx, dy] = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }[event.key]
        nudgeNode(selectedId, dx, dy)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [copySelection, deleteSelection, dirty, editing, handleSave, nudgeNode, pasteSymbol, redoLayout, saving, selectedEdgeId, selectedId, undoLayout])

  /**
   * H — the hand tool, in view mode.
   *
   * The drawing is scaled to fit the panel, so the common case needs no
   * panning at all. The moment an operator zooms in on one skid it does, and
   * view mode has no toolbar to put a button on: H is the drafting convention
   * for the hand, and it is printed on the control it toggles.
   */
  useEffect(() => {
    if (!layout || editing) return undefined
    const shortcut = (event) => {
      if (!isPlainKey(event, 'h')) return
      event.preventDefault()
      setViewPan((on) => !on)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [editing, layout, setViewPan])

  // Entering the editor hands panning to its own tool picker, so the view-mode
  // mode must not survive — otherwise the toolbar would read "select" while
  // the canvas still behaves like a hand.
  useEffect(() => {
    if (editing) {
      setViewPan(false)
      setProductionLogOpen(false)
    }
  }, [editing, setProductionLogOpen, setViewPan])

  useEffect(() => {
    if (!productionLogOpen || editing) return undefined
    const close = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setProductionLogOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [editing, productionLogOpen, setProductionLogOpen])

  // F, in both modes.
  useEffect(() => {
    if (!layout) return undefined
    const shortcut = (event) => {
      if (!isPlainKey(event, 'f')) return
      event.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [layout, toggleFullscreen])
}
