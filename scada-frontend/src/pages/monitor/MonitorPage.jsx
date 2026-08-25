import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useSearchParams } from 'react-router-dom'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import BoltOutlined from '@mui/icons-material/BoltOutlined'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import { useAuthStore } from '@/stores/auth'
import ConnectionAlarmStrip from '@/components/ConnectionAlarm/ConnectionAlarmStrip'
import usePlantData from '@/components/mimic/usePlantData'
import { SYMBOLS, symbolDef, setCustomDefs } from '@/components/mimic/symbols'
import { NORMAL_WIRE } from '@/components/mimic/wireTypes'
import { formatValue, worseStatus } from '@/components/mimic/tagStatus'
import { fetchMimicLayout, fetchMimicLayouts, saveMimicLayout } from '@/api/mimic'
import { fetchDatasources } from '@/api/datasources'
import { fetchMimicSymbols } from '@/api/mimicAssets'
import { apiErrorMessage } from '@/api/client'
import MimicCanvas, { VIEW_W, VIEW_H } from './MimicCanvas'
import DetailRail from './DetailRail'
import SymbolPalette from './SymbolPalette'
import NodeInspector from './NodeInspector'
import EdgeInspector from './EdgeInspector'
import SymbolBindingDialog from './SymbolBindingDialog'
import MimicSwitcher from './MimicSwitcher'
import CustomSymbolDialog from './CustomSymbolDialog'
import MimicEditorToolbar from './MimicEditorToolbar'
import MimicCommandBar from './MimicCommandBar'
import {
  ImportLayoutDialog, RevisionConflictDialog, UnsavedChangesDialog,
} from './EditorDialogs'
import useMimicEditorSession from './useMimicEditorSession'
import { createMimicExport, downloadJson, parseMimicImport } from './editorFiles'
import {
  migrateLayout, readLegacyLayout, clearLegacyLayout, seedLayout, emptyLayout, editLock,
} from './layoutDoc'
import styles from './MonitorPage.module.css'

/**
 * Where a fresh install lands. /monitor drew only this plant before it could
 * hold several, so the slug is also the one the pre-server localStorage
 * drawing belongs to — no other mimic may inherit it.
 */
const FALLBACK_SLUG = 'boiler-1'
const FALLBACK_NAME = 'Boiler House 1'

/**
 * Demo runs the simulator, so it can tick as fast as it likes. Live opens a
 * fresh libpq connection per reading (`_table_source_conn`, no pool) and Live
 * enforces a 5s floor server-side — so the live cadences start there.
 */
const DEMO_CADENCES = [
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
]
const LIVE_CADENCES = [
  { s: 5, label: '5s' },
  { s: 30, label: '30s' },
  { s: 60, label: '1m' },
]

/** The tag "Simulate excursion" pushes over its high-high limit (demo only). */
const EXCURSION_TAG = 'TT-202'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

let addCounter = 0

/**
 * MonitorPage — single-asset mimic for one plant (route: /monitor).
 *
 * /live answers "how are all my things doing?". This answers "what is this
 * plant doing right now, and why?" — one P&ID drawing where the live values
 * sit inside ISA balloons, symbols animate from their own state, and
 * selecting an asset opens its full context in the rail.
 *
 * Each symbol is bound to a real column on a real connection
 * (SymbolBindingDialog), and a mimic may span several backends — one boiler
 * on a historian, a conveyor on another. Bindings and geometry are saved
 * server-side so every operator sees the same commissioned plant; the
 * simulator survives behind the Demo data toggle.
 */
export default function MonitorPage() {
  const role = useAuthStore((s) => s.user?.role ?? null)
  const canEdit = role === 'admin'
  const queryClient = useQueryClient()

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  const notify = useCallback((message, severity = 'success') => {
    setSnackbar({ open: true, message, severity })
  }, [])

  // --- which drawing (?mimic=<slug>) --------------------------------------
  const [searchParams, setSearchParams] = useSearchParams()

  const layoutsQuery = useQuery({ queryKey: ['mimic-layouts'], queryFn: fetchMimicLayouts })
  const layouts = useMemo(() => layoutsQuery.data || [], [layoutsQuery.data])

  const [activeSlug, setActiveSlug] = useState(null)
  const initializedRef = useRef(false)

  const putSlugInUrl = useCallback((slug) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('mimic', slug)
      return p
    }, { replace: true })
  }, [setSearchParams])

  useEffect(() => {
    if (initializedRef.current || layoutsQuery.isPending) return
    initializedRef.current = true
    const wanted = searchParams.get('mimic')
    const next = layouts.find((l) => l.slug === wanted)?.slug
      ?? layouts[0]?.slug
      ?? FALLBACK_SLUG
    setActiveSlug(next)
    putSlugInUrl(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutsQuery.isPending, layouts])

  // The open drawing was deleted — here or in another admin's tab. Fall back to
  // whatever is left rather than polling a slug the server no longer knows.
  //
  // Guards on `activeSlug` being set rather than just `initializedRef`: the
  // effect above sets `initializedRef.current = true` synchronously but its
  // `setActiveSlug` call doesn't land until the next render, so on the very
  // first run after `layouts` loads this effect would otherwise still see the
  // pre-init `null` and stomp the URL's requested slug with `layouts[0]`.
  useEffect(() => {
    if (!initializedRef.current || !layouts.length || !activeSlug) return
    if (layouts.some((l) => l.slug === activeSlug)) return
    setActiveSlug(layouts[0].slug)
    putSlugInUrl(layouts[0].slug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts])

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

  /**
   * Why this drawing cannot be edited here, or null.
   *
   * A save replaces the whole document, so a bundle that can only partly draw
   * one must not offer to write it back — that is how a stale client turns
   * "some symbols are missing" into "the real drawing is gone". One value gates
   * the banner, the Edit button and the canvas, so they cannot disagree.
   */
  const lock = useMemo(() => editLock(layout), [layout])

  // --- data ----------------------------------------------------------------
  const [demo, setDemo] = useState(false)
  const [tickMs, setTickMs] = useState(1000)
  const [pollSeconds, setPollSeconds] = useState(5)

  const {
    tags, history, events, error: dataError, sources: connSources, simulateExcursion, excursionTag,
  } = usePlantData({
    nodes, demo, tickMs, pollSeconds,
  })
  const anySourceFailed = connSources.some((s) => !s.ok)

  const datasourcesQuery = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources })

  /**
   * The custom symbol library.
   *
   * Published into the symbol registry (setCustomDefs) rather than passed down as
   * a prop, because the consumers are synchronous module functions — portPoint
   * routes every wire, resizeBox sizes a drag — and threading an async value
   * through all of them would turn each into a hook. See the note on CUSTOM_DEFS.
   *
   * A drawing renders before this lands. That is fine and expected: a custom node
   * falls back to a frame with no picture until its definition arrives, then fills
   * in. It is the reason the unknown-type path had to be made safe first.
   */
  const customSymbolsQuery = useQuery({
    queryKey: ['mimic-symbols'],
    queryFn: fetchMimicSymbols,
  })
  const customSymbols = useMemo(() => customSymbolsQuery.data || [], [customSymbolsQuery.data])

  // Published during render, not in an effect. The canvas reads the registry
  // synchronously while rendering, so an effect would fire *after* the first
  // paint that needed the new definitions — every custom symbol would draw
  // frameless for one frame, then pop in. Guarded by identity so it runs once
  // per fetch, and idempotent either way.
  const publishedRef = useRef(null)
  if (publishedRef.current !== customSymbols) {
    publishedRef.current = customSymbols
    setCustomDefs(customSymbols)
  }

  const connected = useMemo(
    () => nodes.filter((n) => n.binding?.table && n.binding?.value_col).length,
    [nodes],
  )
  const backendCount = useMemo(() => {
    const ids = new Set()
    nodes.forEach((n) => {
      if (n.binding?.table && n.binding?.value_col) ids.add(n.binding.datasource_id ?? 'app')
    })
    return ids.size
  }, [nodes])

  const plantStatus = useMemo(
    () => Object.values(tags).reduce((acc, t) => worseStatus(acc, t.status), 'normal'),
    [tags],
  )

  // --- selection -----------------------------------------------------------
  // A symbol and a pipe are never selected at once: the rail shows one
  // inspector, so two selections would leave one of them unreachable.
  const [selectedId, setSelectedId] = useState(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [editMode, setEditMode] = useState(false)
  // Local to this page, like AppShell's sidebar collapse — the rail is a
  // viewing preference for this drawing, not something worth persisting.
  const [railCollapsed, setRailCollapsed] = useState(false)
  /**
   * Edit mode is only real when this admin is allowed to write this drawing.
   * Derived here rather than beside `lock` because it reads `editMode`, which is
   * declared with the rest of the selection state below it.
   */
  const editing = editMode && canEdit && !lock
  const dirty = !!editorSession?.dirty
  const canvasRef = useRef(null)
  const [toolMode, setToolMode] = useState('select')
  const [gridVisible, setGridVisible] = useState(true)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [viewport, setViewport] = useState({ x: 0, y: 0, w: VIEW_W, h: VIEW_H })
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [compactEditor, setCompactEditor] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1399px)').matches
  ))
  const [importOpen, setImportOpen] = useState(false)
  const [unsavedOpen, setUnsavedOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [bindingNode, setBindingNode] = useState(null)
  // The upload/author flow. Not per-node: a library symbol is authored once
  // and then placed, so this is a property of the session, not of a selection.
  const [authoring, setAuthoring] = useState(false)

  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    dirty && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
    )
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

  useEffect(() => {
    if (blocker.state === 'blocked') setUnsavedOpen(true)
  }, [blocker.state])

  useEffect(() => {
    if (!dirty) return undefined
    const guard = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  // Switching drawings: nothing from the old one survives. Every id here names
  // a node or pipe that is about to stop existing, and the binding dialog in
  // particular would otherwise write its result into the plant next door.
  useEffect(() => {
    if (seededSlugRef.current === null || seededSlugRef.current === activeSlug) return
    seededSlugRef.current = null
    loadLayout(null)
    setSelectedId(null)
    setSelectedEdgeId(null)
    setBindingNode(null)
  }, [activeSlug, loadLayout])

  const selectMimic = useCallback((slug) => {
    if (!slug || slug === activeSlug) return
    setActiveSlug(slug)
    putSlugInUrl(slug)
  }, [activeSlug, putSlugInUrl])

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null
  const selectedEdge = (layout?.edges ?? []).find((e) => e.id === selectedEdgeId) ?? null
  const selectedTag = selectedId ? tags[selectedId] ?? null : null

  const selectNode = useCallback((id) => {
    setSelectedId(id)
    setSelectedEdgeId(null)
  }, [])

  const selectEdge = useCallback((id) => {
    setSelectedEdgeId(id)
    setSelectedId(null)
  }, [])

  // --- geometry edits ------------------------------------------------------
  const moveNode = useCallback((id, pos) => {
    previewLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...pos } : n)),
    }))
  }, [previewLayout])

  // Resolved against the node in `prev` rather than the rendered one so a
  // burst of key repeats accumulates instead of collapsing to the last one.
  const nudgeNode = useCallback((id, dx, dy) => {
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? {
          ...n,
          x: clamp(n.x + dx, 0, VIEW_W - n.w),
          y: clamp(n.y + dy, 0, VIEW_H - n.h),
        }
        : n)),
    }))
  }, [commitLayout])

  // Ports are fractions of the node box and edge geometry is never stored, so
  // a resize re-routes every wire on the symbol for free. The canvas has
  // already snapped and clamped the box.
  const resizeNode = useCallback((id, box) => {
    previewLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...box } : n)),
    }))
  }, [previewLayout])

  // Rotation was already wired end to end on the canvas — the transform is
  // applied and resizeBox un-rotates pointer deltas — with nothing to set it.
  // Stored in degrees, normalised so a rotated symbol reports 15° rather than 375°.
  const rotateNode = useCallback((id, deg) => {
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? { ...n, rot: ((Math.round(deg) % 360) + 360) % 360 }
        : n)),
    }))
  }, [commitLayout])

  // Back to the size the symbol was drawn at. Position is left alone: the
  // symbol is where the engineer put it, and only its size was in question.
  const resetNodeSize = useCallback((id) => {
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? { ...n, ...(symbolDef(n)?.defaultSize ?? { w: n.w, h: n.h }) }
        : n)),
    }))
  }, [commitLayout])

  // Deleting a node takes its wires with it — an edge whose endpoint is gone
  // has no geometry to derive.
  const deleteNode = useCallback((id) => {
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== id),
      edges: prev.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    }))
    setSelectedId(null)
    // One of the pipes that just went with it may have been the selection.
    setSelectedEdgeId(null)
  }, [commitLayout])

  // --- balloon placement ---------------------------------------------------
  // Stored as an offset from the symbol's own anchor, so a repositioned
  // reading follows its equipment the next time that equipment is dragged.
  const moveBubble = useCallback((id, offset) => {
    previewLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, bubble: { offset } } : n)),
    }))
  }, [previewLayout])

  const resetBubble = useCallback((id) => {
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, bubble: null } : n)),
    }))
  }, [commitLayout])

  // --- wiring --------------------------------------------------------------
  // The pen: which line the next wire is drawn in. Held here rather than
  // inside the picker so the canvas can preview the real line as it is being
  // dragged, and so it survives selecting a symbol — running a fuel branch
  // should not mean re-picking the type for every segment of it.
  const [wirePen, setWirePen] = useState(NORMAL_WIRE)

  const addEdge = useCallback((from, to) => {
    if (from.node === to.node) {
      notify('A wire runs between two different symbols.', 'warning')
      return
    }
    const ends = { from, to: { node: to.node, port: to.port } }
    // Direction is a drawing choice, not a fact about the plant, so a wire
    // drawn back the other way is the same wire — select it rather than
    // stacking a second line on the identical route.
    const existing = layout.edges.find((e) => (
      (e.from.node === from.node && e.from.port === from.port
        && e.to.node === ends.to.node && e.to.port === ends.to.port)
      || (e.from.node === ends.to.node && e.from.port === ends.to.port
        && e.to.node === from.node && e.to.port === from.port)
    ))
    if (existing) {
      selectEdge(existing.id)
      notify('These ports are already connected.', 'info')
      return
    }
    addCounter += 1
    const id = `e-new-${Date.now().toString(36)}-${addCounter}`
    commitLayout((prev) => ({
      ...prev,
      edges: [...prev.edges, {
        id, ...ends, service: wirePen, flowNode: null,
      }],
    }))
    selectEdge(id)
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
  }, [commitLayout])

  const deleteEdge = useCallback((id) => {
    commitLayout((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== id) }))
    setSelectedEdgeId(null)
  }, [commitLayout])

  /**
   * Drop a new symbol at the centre of the sheet.
   *
   * `symbolId` names a library entry and is only meaningful for `custom`. It has
   * to be on the node from the moment it is created — the size and ports come off
   * that entry, so a custom node without one would be placed at the generic
   * fallback size and then jump when it resolved.
   */
  const addSymbol = useCallback((type, symbolId = null, point = null) => {
    const def = symbolDef({ type, symbolId }) ?? SYMBOLS[type]
    addCounter += 1
    const id = `n-new-${Date.now().toString(36)}-${addCounter}`
    const rawX = (point?.x ?? VIEW_W / 2) - def.defaultSize.w / 2
    const rawY = (point?.y ?? VIEW_H / 2) - def.defaultSize.h / 2
    const place = (value) => (snapEnabled ? Math.round(value / 8) * 8 : Math.round(value))
    const node = {
      id,
      type,
      ...(symbolId == null ? {} : { symbolId }),
      tagId: null,
      binding: null,
      label: def.label,
      x: clamp(place(rawX), 0, VIEW_W - def.defaultSize.w),
      y: clamp(place(rawY), 0, VIEW_H - def.defaultSize.h),
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      rot: 0,
    }
    commitLayout((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    selectNode(id)
  }, [commitLayout, selectNode, snapEnabled])

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
        setConflictOpen(true)
        return null
      }
      notify(apiErrorMessage(e, 'Failed to save the layout.'), 'error')
      return null
    } finally {
      setSaving(false)
    }
  }, [activeName, activeSlug, editorSession?.revision, notify, queryClient])

  const deleteNodeKey = useCallback((id) => {
    deleteNode(id)
  }, [deleteNode])

  const deleteEdgeKey = useCallback((id) => {
    deleteEdge(id)
  }, [deleteEdge])

  // --- binding dialog ------------------------------------------------------
  const openBinding = useCallback((node) => setBindingNode(node), [])

  const applyBinding = useCallback(({ tagId, label, binding }) => {
    const next = {
      ...layout,
      nodes: layout.nodes.map((n) => (n.id === bindingNode.id
        ? { ...n, tagId, label, binding }
        : n)),
    }
    commitLayout(next)
    setBindingNode(null)
    notify(binding ? 'Binding updated in the draft.' : 'Symbol disconnected in the draft.')
  }, [bindingNode, commitLayout, layout, notify])

  const toggleEdit = useCallback(() => {
    if (!editMode) setEditMode(true)
  }, [editMode])

  const handleSave = useCallback(async () => {
    const row = await persist(layout)
    if (!row) return
    savedLayout(migrateLayout(row.doc), row.updated_at)
    setEditMode(false)
    setSelectedEdgeId(null)
  }, [layout, persist, savedLayout])

  const finishCancel = useCallback(() => {
    cancelLayout()
    setEditMode(false)
    setSelectedId(null)
    setSelectedEdgeId(null)
    setBindingNode(null)
    setUnsavedOpen(false)
  }, [cancelLayout])

  const requestCancel = useCallback(() => {
    if (dirty) setUnsavedOpen(true)
    else finishCancel()
  }, [dirty, finishCancel])

  // "Back to how this drawing started" — which is the seeded steam skid for
  // the plant /monitor shipped with, and a blank sheet for one an admin drew.
  const handleReset = useCallback(() => {
    commitLayout(activeSlug === FALLBACK_SLUG ? seedLayout() : emptyLayout(activeName))
    setSelectedId(null)
    setSelectedEdgeId(null)
  }, [activeName, activeSlug, commitLayout])

  const exportDraft = useCallback(() => {
    const envelope = createMimicExport({ slug: activeSlug, name: activeName }, layout)
    downloadJson(`${activeSlug || 'mimic'}.mml.json`, envelope)
  }, [activeName, activeSlug, layout])

  const importDraft = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const parsed = parseMimicImport(JSON.parse(await file.text()), { slug: activeSlug, name: activeName })
      const migrated = migrateLayout(parsed)
      if (!migrated) throw new Error('The selected file is not a supported MML layout document.')
      const imported = {
        ...layout,
        viewBox: migrated.viewBox,
        nodes: migrated.nodes,
        edges: migrated.edges,
        name: activeName,
      }
      const importLock = editLock(imported)
      if (importLock) throw new Error(importLock)
      const importedNodes = new Map(imported.nodes.map((node) => [node.id, node]))
      const customIds = new Set(customSymbols.map((symbol) => symbol.id))
      const missingCustom = imported.nodes.find((node) => (
        node.type === 'custom'
        && (!Number.isInteger(node.symbolId) || !customIds.has(node.symbolId))
      ))
      if (missingCustom) {
        throw new Error('The selected layout references a custom symbol that is not installed on this server.')
      }
      const badPort = imported.edges.some((edge) => (
        !symbolDef(importedNodes.get(edge.from.node))?.ports?.[edge.from.port]
        || !symbolDef(importedNodes.get(edge.to.node))?.ports?.[edge.to.port]
      ))
      if (badPort) throw new Error('The selected layout contains a wire attached to an unsupported symbol port.')
      commitLayout(imported)
      setSelectedId(null)
      setSelectedEdgeId(null)
      setImportOpen(false)
      notify('Layout imported into the draft.', 'success')
    } catch (error) {
      notify(error.message || 'The selected file could not be imported.', 'error')
    } finally {
      event.target.value = ''
    }
  }, [activeName, activeSlug, commitLayout, customSymbols, layout, notify])

  const reloadServerRevision = useCallback(async () => {
    try {
      const result = await layoutQuery.refetch({ throwOnError: true })
      if (!result.data?.doc) throw new Error('The server revision could not be loaded.')
      loadLayout(migrateLayout(result.data.doc), result.data.updated_at)
      setSelectedId(null)
      setSelectedEdgeId(null)
      setBindingNode(null)
      setConflictOpen(false)
    } catch (error) {
      notify(apiErrorMessage(error, 'The server revision could not be loaded. Your draft is still intact.'), 'error')
    }
  }, [layoutQuery, loadLayout, notify])

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) deleteEdge(selectedEdgeId)
    else if (selectedId) deleteNode(selectedId)
  }, [deleteEdge, deleteNode, selectedEdgeId, selectedId])

  const rotateSelection = useCallback(() => {
    if (selectedNode) rotateNode(selectedNode.id, (selectedNode.rot || 0) + 90)
  }, [rotateNode, selectedNode])

  const keepEditing = useCallback(() => {
    setUnsavedOpen(false)
    if (blocker.state === 'blocked') blocker.reset()
  }, [blocker])

  const discardUnsaved = useCallback(() => {
    const navigating = blocker.state === 'blocked'
    finishCancel()
    if (navigating) blocker.proceed()
  }, [blocker, finishCancel])

  useEffect(() => {
    if (!editing) return undefined
    const shortcut = (event) => {
      if (saving) return
      if (event.defaultPrevented) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (dirty && !saving) handleSave()
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
  }, [deleteSelection, dirty, editing, handleSave, nudgeNode, redoLayout, saving, selectedEdgeId, selectedId, undoLayout])

  const dotClass = plantStatus === 'crit' ? styles.dotCrit
    : plantStatus === 'warn' ? styles.dotWarn : ''


  const cadence = demo ? (
    <div className={styles.cadence} role="group" aria-label="Update interval">
      {DEMO_CADENCES.map((c) => (
        <button
          key={c.ms}
          type="button"
          className={`${styles.cadenceBtn} ${tickMs === c.ms ? styles.cadenceOn : ''}`}
          aria-pressed={tickMs === c.ms}
          onClick={() => setTickMs(c.ms)}
        >
          {c.label}
        </button>
      ))}
    </div>
  ) : (
    <div className={styles.cadence} role="group" aria-label="Poll interval">
      {LIVE_CADENCES.map((c) => (
        <button
          key={c.s}
          type="button"
          className={`${styles.cadenceBtn} ${pollSeconds === c.s ? styles.cadenceOn : ''}`}
          aria-pressed={pollSeconds === c.s}
          onClick={() => setPollSeconds(c.s)}
        >
          {c.label}
        </button>
      ))}
    </div>
  )

  const subtitle = demo
    ? 'Simulated process · no datasource'
    : nodes.length === 0
      ? 'Empty drawing · add symbols from the palette in edit mode'
      : connected === 0
        ? 'No symbols connected yet'
        : `${connected} of ${nodes.length} symbols connected · ${backendCount} ${backendCount === 1 ? 'connection' : 'connections'}`

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={styles.titleWrap}>
          <MimicSwitcher
            layouts={layouts}
            activeSlug={activeSlug}
            activeName={activeName}
            canManage={canEdit}
            // A draft belongs to one server revision. Switching drawings is
            // disabled until the administrator saves or cancels the session.
            disabled={editMode}
            onSelect={selectMimic}
          />
          <p className={styles.sub}>{subtitle}</p>
        </div>

        <span className={styles.plantState}>
          <span className={`${styles.dot} ${dotClass}`} />
          {plantStatus === 'crit' ? 'Alarm' : plantStatus === 'warn' ? 'Off normal' : 'Running'}
        </span>

        <div className={styles.actions}>
          <FormControlLabel
            className={styles.demoToggle}
            control={<Switch size="small" checked={demo} onChange={(e) => setDemo(e.target.checked)} />}
            label="Demo data"
          />

          {cadence}

          {/* Outside demo mode this drives a simulator nothing is reading. */}
          {demo && (
            <Button
              startIcon={<BoltOutlined />}
              color={excursionTag ? 'warning' : 'inherit'}
              onClick={() => simulateExcursion(EXCURSION_TAG)}
              title={`Drive ${EXCURSION_TAG} past its high-high limit for 15 seconds`}
            >
              Simulate excursion
            </Button>
          )}

          {canEdit && !!layout && !lock && (
            !editMode && (
              <Button
                variant="outlined"
                color="inherit"
                onClick={toggleEdit}
              >
                Edit layout
              </Button>
            )
          )}
        </div>
      </header>

      {/* Read-only, and why. Sits above the data error because it describes
        * the drawing itself rather than this tick's poll. */}
      {lock && <Alert severity="warning">{lock}</Alert>}

      <ConnectionAlarmStrip sources={connSources} />

      {/* Named alarm tiles above already say which source and for how long;
        * the generic banner only earns its place when the strip has nothing
        * to say (e.g. a stale-but-answering source). */}
      {dataError && !anySourceFailed && <Alert severity="warning">{dataError}</Alert>}

      {/* Only the drawing waits on the switch — the switcher itself stays put,
        * so the control you just used does not vanish under your cursor. */}
      {!layout && <p className={styles.loading}>Loading the plant drawing…</p>}

      {layout && editing && (
        <div
          className={`${styles.editorWorkspace} ${saving ? styles.editorWorkspaceSaving : ''}`}
          aria-busy={saving}
          inert={saving ? true : undefined}
        >
          <aside className={`${styles.editorPaletteRail} ${paletteOpen ? '' : styles.editorRailClosed}`}>
            <button
              type="button"
              className={styles.editorRailToggle}
              aria-expanded={paletteOpen}
              onClick={togglePalette}
            >
              {paletteOpen ? 'Hide symbols' : 'Symbols'}
            </button>
            {paletteOpen && (
              <SymbolPalette
                onAdd={addSymbol}
                customSymbols={customSymbols}
                onAuthorSymbol={() => setAuthoring(true)}
              />
            )}
          </aside>

          <main className={styles.editorCenter}>
            <MimicEditorToolbar
              toolMode={toolMode}
              onToolMode={setToolMode}
              wirePen={wirePen}
              onWirePen={setWirePen}
              gridVisible={gridVisible}
              onGridVisible={setGridVisible}
              snapEnabled={snapEnabled}
              onSnapEnabled={setSnapEnabled}
              zoomPercent={Math.round(((layout.viewBox?.w || VIEW_W) / viewport.w) * 100)}
              onZoomOut={() => canvasRef.current?.zoomOut()}
              onZoomIn={() => canvasRef.current?.zoomIn()}
              onResetView={() => canvasRef.current?.resetView()}
              onFit={() => canvasRef.current?.fitContents()}
              onFullscreen={() => canvasRef.current?.fullscreen()}
              onSnapshot={() => canvasRef.current?.snapshot()}
              onTogglePalette={togglePalette}
              onToggleInspector={toggleInspector}
            />
            <div className={styles.editorCanvas}>
              <MimicCanvas
                ref={canvasRef}
                layout={layout}
                tags={tags}
                selectedId={selectedId}
                onSelect={selectNode}
                selectedEdgeId={selectedEdgeId}
                onSelectEdge={selectEdge}
                editMode={!saving}
                wirePen={wirePen}
                toolMode={toolMode}
                gridVisible={gridVisible}
                snapEnabled={snapEnabled}
                onViewportChange={setViewport}
                onGestureStart={beginGesture}
                onGestureEnd={endGesture}
                onGestureCancel={abortGesture}
                onMoveNode={moveNode}
                onNudgeNode={nudgeNode}
                onResizeNode={resizeNode}
                onDeleteNode={deleteNodeKey}
                onAddEdge={addEdge}
                onDeleteEdge={deleteEdgeKey}
                onMoveBubble={moveBubble}
                onOpenBinding={openBinding}
                onDropSymbol={({ type, symbolId }, point) => addSymbol(type, symbolId, point)}
              />
            </div>
            <MimicCommandBar
              canUndo={editorSession.past.length > 0}
              canRedo={editorSession.future.length > 0}
              hasSelection={!!selectedNode || !!selectedEdge}
              canRotate={!!selectedNode}
              dirty={dirty}
              saving={saving}
              onUndo={undoLayout}
              onRedo={redoLayout}
              onRotate={rotateSelection}
              onDelete={deleteSelection}
              onReset={handleReset}
              onImport={() => setImportOpen(true)}
              onExport={exportDraft}
              onCancel={requestCancel}
              onSave={handleSave}
            />
          </main>

          <aside className={`${styles.editorInspectorRail} ${inspectorOpen ? '' : styles.editorRailClosed}`}>
            <button
              type="button"
              className={styles.editorRailToggle}
              aria-expanded={inspectorOpen}
              onClick={toggleInspector}
            >
              {inspectorOpen ? 'Hide inspector' : 'Inspector'}
            </button>
            {inspectorOpen && (selectedEdge ? (
              <EdgeInspector
                edge={selectedEdge}
                nodes={nodes}
                onChange={(patch) => updateEdge(selectedEdge.id, patch)}
                onDelete={deleteEdge}
                onBack={() => setSelectedEdgeId(null)}
              />
            ) : selectedNode ? (
              <NodeInspector
                node={selectedNode}
                datasources={datasourcesQuery.data || []}
                onConnect={() => openBinding(selectedNode)}
                onDelete={deleteNode}
                onResetBubble={resetBubble}
                onResetSize={resetNodeSize}
                onRotate={rotateNode}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <div className={styles.editorHelp}>
                <span>Inspector</span>
                <h3>Select a symbol or wire</h3>
                <p>Properties, datasource bindings, rotation, size, and flow rules appear here. Drag from a symbol port to create a connection.</p>
                <kbd>Space + drag</kbd><small>Pan canvas</small>
                <kbd>Ctrl/Cmd + wheel</kbd><small>Zoom at pointer</small>
              </div>
            ))}
          </aside>
        </div>
      )}

      {layout && !editing && (
        <div className={styles.body}>
          <MimicCanvas
            layout={layout}
            tags={tags}
            selectedId={selectedId}
            onSelect={selectNode}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={selectEdge}
            onMoveNode={moveNode}
            onNudgeNode={nudgeNode}
            onResizeNode={resizeNode}
            onDeleteNode={deleteNodeKey}
            onAddEdge={addEdge}
            onDeleteEdge={deleteEdgeKey}
            onMoveBubble={moveBubble}
          />
          <div className={`${styles.railCol} ${railCollapsed ? styles.railColCollapsed : ''}`}>
            <IconButton className={styles.railToggle} size="small" onClick={() => setRailCollapsed((c) => !c)}>
              {railCollapsed ? <ChevronLeft fontSize="small" /> : <ChevronRight fontSize="small" />}
            </IconButton>
            {!railCollapsed && (
              <DetailRail tag={selectedTag} node={selectedNode} history={selectedId ? history[selectedId] : null} events={events} canBind={false} />
            )}
          </div>
        </div>
      )}

      {/* An empty drawing has no ticker to show; the bare strip would just be
        * a box with nothing in it. */}
      {nodes.length > 0 && (
      <div className={styles.strip} role="group" aria-label="All plant tags">
        {nodes.map((node) => {
          const tag = tags[node.id]
          const on = selectedId === node.id
          const tone = tag?.status === 'crit' ? styles.chipCrit
            : tag?.status === 'warn' ? styles.chipWarn : ''
          return (
            <button
              key={node.id}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''} ${tone} ${tag ? '' : styles.chipUnbound}`}
              aria-pressed={on}
              onClick={() => selectNode(node.id)}
            >
              <span className={styles.chipId}>{node.tagId || node.label}</span>
              <span className={styles.chipValue}>{tag ? formatValue(tag) : '—'}</span>
              {tag?.unit && <span className={styles.chipUnit}>{tag.unit}</span>}
            </button>
          )
        })}
      </div>
      )}

      <SymbolBindingDialog
        open={!!bindingNode}
        node={bindingNode}
        onClose={() => setBindingNode(null)}
        onSave={applyBinding}
      />

      <CustomSymbolDialog
        open={authoring}
        onClose={() => setAuthoring(false)}
        onSaved={(row) => {
          queryClient.invalidateQueries({ queryKey: ['mimic-symbols'] })
          setAuthoring(false)
          notify(`“${row.name}” added to the symbol library.`)
        }}
      />

      <ImportLayoutDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importDraft} />
      <UnsavedChangesDialog open={unsavedOpen} onStay={keepEditing} onDiscard={discardUnsaved} />
      <RevisionConflictDialog
        open={conflictOpen}
        onContinue={() => setConflictOpen(false)}
        onExport={exportDraft}
        onReload={reloadServerRevision}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </div>
  )
}
