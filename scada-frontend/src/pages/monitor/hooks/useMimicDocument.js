import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMimicLayout, saveMimicLayout } from '@/api/mimic'
import { apiErrorMessage } from '@/api/client'
import useMimicEditorSession from '../useMimicEditorSession'
import { readKpis } from '../kpiBoxes'
import {
  FALLBACK_NAME, FALLBACK_SLUG, clearLegacyLayout, editLock, emptyLayout, migrateLayout,
  readLegacyLayout, seedLayout,
} from '../layoutDoc'

/**
 * The open drawing's document: loaded from the server (the source of truth),
 * held in an undoable editor session, and saved back with a revision check.
 *
 * `onConflict` is called when a save loses the revision race (HTTP 409); the
 * caller decides how to tell the admin.
 */
export default function useMimicDocument({
  activeSlug, layouts, notify, onConflict,
}) {
  const queryClient = useQueryClient()

  // --- layout: server is the source of truth ------------------------------
  const layoutQuery = useQuery({
    queryKey: ['mimic-layout', activeSlug],
    queryFn: () => fetchMimicLayout(activeSlug),
    enabled: !!activeSlug,
    // 404 is the normal first-run answer, not a failure to retry.
    retry: (count, err) => err?.response?.status !== 404 && count < 2,
  })

  const {
    session: editorSession,
    document: layout,
    load: loadLayout,
    preview: previewLayout,
    commit: commitLayout,
    beginGesture,
    endGesture,
    abortGesture,
    undo: undoLayout,
    redo: redoLayout,
    cancel: cancelLayout,
    saved: savedLayout,
  } = useMimicEditorSession()
  const legacyPendingRef = useRef(false)
  // Which slug the drawing on screen belongs to. Without this the seed guard
  // below would read "have I seeded anything?" and a switch would keep showing
  // the previous plant under the new plant's name.
  const seededSlugRef = useRef(null)

  useEffect(() => {
    if (!activeSlug || seededSlugRef.current === activeSlug || layoutQuery.isPending) return
    const server = layoutQuery.data?.doc ? migrateLayout(layoutQuery.data.doc) : null
    seededSlugRef.current = activeSlug
    if (server) { loadLayout(server, layoutQuery.data?.updated_at ?? null); return }
    // Nothing on the server. An admin may still have a hand-arranged drawing
    // in this browser from before /monitor had a backend — carry its geometry
    // into the first save rather than replacing it with the seed. It belongs
    // to one plant, so only that plant's slug may claim it.
    if (activeSlug === FALLBACK_SLUG) {
      const legacy = readLegacyLayout()
      if (legacy) {
        legacyPendingRef.current = true
        loadLayout(legacy, null)
        return
      }
      loadLayout(seedLayout(), null)
      return
    }
    loadLayout(emptyLayout(layouts.find((l) => l.slug === activeSlug)?.name ?? activeSlug), null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug, layoutQuery.isPending, layoutQuery.data, layouts, loadLayout])

  // The document's own name wins: it is what the last save wrote, so it is
  // right even in the moment before the list query catches up with a rename.
  const activeName = layout?.name
    || layouts.find((l) => l.slug === activeSlug)?.name
    || FALLBACK_NAME

  const nodes = useMemo(() => layout?.nodes ?? [], [layout])

  // The headline strip. A pure read: `migrateLayout` already repaired this list
  // at the document boundary, and minting an id here would mint a *new* one on
  // every layout edit — moving the poller's query key and discarding that box's
  // history each time an admin nudged an unrelated symbol.
  const kpis = useMemo(() => readKpis(layout?.kpis), [layout])

  /**
   * Why this drawing cannot be edited here, or null.
   *
   * A save replaces the whole document, so a bundle that can only partly draw
   * one must not offer to write it back — that is how a stale client turns
   * "some symbols are missing" into "the real drawing is gone". One value gates
   * the banner, the Edit button and the canvas, so they cannot disagree.
   */
  const lock = useMemo(() => editLock(layout), [layout])

  const dirty = !!editorSession?.dirty

  // --- persistence ---------------------------------------------------------
  const [saving, setSaving] = useState(false)

  const persist = useCallback(async (doc) => {
    setSaving(true)
    try {
      const row = await saveMimicLayout(
        activeSlug,
        doc.name || activeName,
        doc,
        editorSession?.revision ?? null,
      )
      if (legacyPendingRef.current) {
        clearLegacyLayout()
        legacyPendingRef.current = false
      }
      // On a fresh install this PUT is what puts the fallback plant in the
      // table for the first time, so the switcher's list is now out of date.
      queryClient.setQueryData(['mimic-layout', activeSlug], row)
      queryClient.invalidateQueries({ queryKey: ['mimic-layouts'] })
      notify('Layout saved.')
      return row
    } catch (e) {
      if (e?.response?.status === 409) {
        onConflict()
        return null
      }
      notify(apiErrorMessage(e, 'Failed to save the layout.'), 'error')
      return null
    } finally {
      setSaving(false)
    }
  }, [activeName, activeSlug, editorSession?.revision, notify, onConflict, queryClient])

  /**
   * Replace the draft with the server's current revision. `onLoaded` runs once
   * the new document is in, so the caller can drop selection state that named
   * nodes from the old one.
   */
  const reloadServerRevision = useCallback(async (onLoaded) => {
    try {
      const result = await layoutQuery.refetch({ throwOnError: true })
      if (!result.data?.doc) throw new Error('The server revision could not be loaded.')
      loadLayout(migrateLayout(result.data.doc), result.data.updated_at)
      onLoaded?.()
    } catch (error) {
      notify(apiErrorMessage(error, 'The server revision could not be loaded. Your draft is still intact.'), 'error')
    }
  }, [layoutQuery, loadLayout, notify])

  return {
    editorSession,
    layout,
    nodes,
    kpis,
    lock,
    dirty,
    saving,
    activeName,
    loadLayout,
    previewLayout,
    commitLayout,
    beginGesture,
    endGesture,
    abortGesture,
    undoLayout,
    redoLayout,
    cancelLayout,
    savedLayout,
    seededSlugRef,
    persist,
    reloadServerRevision,
  }
}
