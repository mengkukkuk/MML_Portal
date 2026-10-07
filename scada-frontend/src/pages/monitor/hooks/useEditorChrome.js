import { useCallback, useEffect, useState } from 'react'
import { NORMAL_WIRE } from '@/components/mimic/wireTypes'

/**
 * The editor's own furniture: the drafting tools (pen, grid, snap) and the two
 * side rails.
 *
 * Below the palette/inspector breakpoint the rails are mutually exclusive, so
 * anything that selects a symbol or wire calls `revealInspector` to swap them —
 * otherwise the properties panel a symbol was just clicked *for* stays hidden
 * behind the palette, and every option in it looks like it went missing.
 */
export default function useEditorChrome() {
  const [toolMode, setToolMode] = useState('select')
  const [gridVisible, setGridVisible] = useState(true)
  const [snapEnabled, setSnapEnabled] = useState(true)
  // The pen: which line the next wire is drawn in. Held here rather than
  // inside the picker so the canvas can preview the real line as it is being
  // dragged, and so it survives selecting a symbol — running a fuel branch
  // should not mean re-picking the type for every segment of it.
  const [wirePen, setWirePen] = useState(NORMAL_WIRE)

  const [paletteOpen, setPaletteOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [compactEditor, setCompactEditor] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1399px)').matches
  ))

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1399px)')
    const syncBreakpoint = () => {
      setCompactEditor(media.matches)
      if (media.matches) {
        setPaletteOpen(true)
        setInspectorOpen(false)
      } else {
        setPaletteOpen(true)
        setInspectorOpen(true)
      }
    }
    syncBreakpoint()
    media.addEventListener('change', syncBreakpoint)
    return () => media.removeEventListener('change', syncBreakpoint)
  }, [])

  const togglePalette = useCallback(() => {
    const nextOpen = !paletteOpen
    setPaletteOpen(nextOpen)
    if (nextOpen && compactEditor) setInspectorOpen(false)
  }, [compactEditor, paletteOpen])

  const toggleInspector = useCallback(() => {
    const nextOpen = !inspectorOpen
    setInspectorOpen(nextOpen)
    if (nextOpen && compactEditor) setPaletteOpen(false)
  }, [compactEditor, inspectorOpen])

  const revealInspector = useCallback(() => {
    if (compactEditor) { setInspectorOpen(true); setPaletteOpen(false) }
  }, [compactEditor])

  return {
    toolMode, setToolMode,
    gridVisible, setGridVisible,
    snapEnabled, setSnapEnabled,
    wirePen, setWirePen,
    paletteOpen, inspectorOpen,
    togglePalette, toggleInspector, revealInspector,
  }
}
