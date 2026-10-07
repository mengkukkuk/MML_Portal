import { useState } from 'react'
import { VIEW_H, VIEW_W } from '../sheet.js'

/**
 * Page-level view state that several hooks and both modes share: which dialogs
 * are open, the view-mode hand tool, the rail fold, and the canvas viewport.
 *
 * Held in one place (and at the page, not inside the mode components) so that a
 * mode switch does not reset it, and so hooks that must close or open a dialog
 * — drawing switch, cancel, import, save conflict — can do so without the hook
 * that owns the dialog having to exist before them.
 */
export default function useMonitorUi() {
  const [productionLogOpen, setProductionLogOpen] = useState(false)
  const [productionSettingsOpen, setProductionSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [unsavedOpen, setUnsavedOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [bindingNode, setBindingNode] = useState(null)
  const [editingKpi, setEditingKpi] = useState(null)
  // The upload/author flow. Not per-node: a library symbol is authored once
  // and then placed, so this is a property of the session, not of a selection.
  const [authoring, setAuthoring] = useState(false)
  // The hand tool, in view mode. Edit mode has `toolMode` and a toolbar to set
  // it; a running mimic has neither, so the mode lives here and on one key.
  const [viewPan, setViewPan] = useState(false)
  // Local to this page, like AppShell's sidebar collapse — the rail is a
  // viewing preference for this drawing, not something worth persisting.
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [viewport, setViewport] = useState({ x: 0, y: 0, w: VIEW_W, h: VIEW_H })

  return {
    productionLogOpen, setProductionLogOpen,
    productionSettingsOpen, setProductionSettingsOpen,
    importOpen, setImportOpen,
    unsavedOpen, setUnsavedOpen,
    conflictOpen, setConflictOpen,
    bindingNode, setBindingNode,
    editingKpi, setEditingKpi,
    authoring, setAuthoring,
    viewPan, setViewPan,
    railCollapsed, setRailCollapsed,
    viewport, setViewport,
  }
}
