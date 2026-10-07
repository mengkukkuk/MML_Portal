import { useCallback, useEffect, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import {
  FALLBACK_SLUG, emptyLayout, migrateLayout, seedLayout,
} from '../layoutDoc'

/**
 * The edit session's life cycle: entering edit mode, saving, cancelling, going
 * back to the seed, and not losing an unsaved draft.
 *
 * Edit mode is only real when this admin is allowed to write this drawing
 * (`editing`), so one value gates the toolbar, the canvas and the shortcuts.
 * A dirty draft blocks in-app navigation (react-router's `useBlocker`) and tab
 * close (`beforeunload`); the blocked navigation is held until the admin
 * chooses to keep editing or discard.
 */
export default function useEditLifecycle({
  canEdit, activeSlug, doc, selection, ui,
}) {
  const {
    layout, lock, dirty, persist, savedLayout, cancelLayout, commitLayout, activeName,
  } = doc
  const { setSelectedId, setSelectedEdgeId } = selection
  const { setBindingNode, setProductionSettingsOpen, setUnsavedOpen } = ui

  const [editMode, setEditMode] = useState(false)
  const editing = editMode && canEdit && !lock

  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    dirty && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
    )
  ))

  useEffect(() => {
    if (blocker.state === 'blocked') setUnsavedOpen(true)
  }, [blocker.state, setUnsavedOpen])

  useEffect(() => {
    if (!dirty) return undefined
    const guard = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const startEditing = useCallback(() => {
    if (!editMode) setEditMode(true)
  }, [editMode])

  const handleSave = useCallback(async () => {
    const row = await persist(layout)
    if (!row) return
    savedLayout(migrateLayout(row.doc), row.updated_at)
    setEditMode(false)
    setSelectedEdgeId(null)
  }, [layout, persist, savedLayout, setSelectedEdgeId])

  const finishCancel = useCallback(() => {
    cancelLayout()
    setEditMode(false)
    setSelectedId(null)
    setSelectedEdgeId(null)
    setBindingNode(null)
    setProductionSettingsOpen(false)
    setUnsavedOpen(false)
  }, [cancelLayout, setBindingNode, setProductionSettingsOpen, setSelectedEdgeId, setSelectedId, setUnsavedOpen])

  const requestCancel = useCallback(() => {
    if (dirty) setUnsavedOpen(true)
    else finishCancel()
  }, [dirty, finishCancel, setUnsavedOpen])

  // "Back to how this drawing started" — which is the seeded steam skid for
  // the plant /monitor shipped with, and a blank sheet for one an admin drew.
  const handleReset = useCallback(() => {
    commitLayout(activeSlug === FALLBACK_SLUG ? seedLayout() : emptyLayout(activeName))
    setSelectedId(null)
    setSelectedEdgeId(null)
  }, [activeName, activeSlug, commitLayout, setSelectedEdgeId, setSelectedId])

  const keepEditing = useCallback(() => {
    setUnsavedOpen(false)
    if (blocker.state === 'blocked') blocker.reset()
  }, [blocker, setUnsavedOpen])

  const discardUnsaved = useCallback(() => {
    const navigating = blocker.state === 'blocked'
    finishCancel()
    if (navigating) blocker.proceed()
  }, [blocker, finishCancel])

  return {
    editMode, editing, startEditing, handleSave, requestCancel, handleReset, keepEditing, discardUnsaved,
  }
}
