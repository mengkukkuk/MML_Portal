import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useSearchParams } from 'react-router-dom'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import Portal from '@mui/material/Portal'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import PanToolOutlined from '@mui/icons-material/PanToolOutlined'
import ZoomInOutlined from '@mui/icons-material/ZoomInOutlined'
import ZoomOutOutlined from '@mui/icons-material/ZoomOutOutlined'
import CenterFocusStrongOutlined from '@mui/icons-material/CenterFocusStrongOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import FullscreenOutlined from '@mui/icons-material/FullscreenOutlined'
import FullscreenExitOutlined from '@mui/icons-material/FullscreenExitOutlined'
import BarChartOutlined from '@mui/icons-material/BarChartOutlined'
import { useAuthStore } from '@/stores/auth'
import ConnectionAlarmStrip from '@/components/ConnectionAlarm/ConnectionAlarmStrip'
import usePlantData from '@/components/mimic/usePlantData'
import useMimicTables from '@/components/mimic/useMimicTables'
import { SYMBOLS, symbolDef, setCustomDefs, isCameraNode } from '@/components/mimic/symbols'
import { NORMAL_WIRE } from '@/components/mimic/wireTypes'
import { formatValue, worseStatus } from '@/components/mimic/tagStatus'
import { fetchMimicLayout, fetchMimicLayouts, saveMimicLayout } from '@/api/mimic'
import { fetchDatasources } from '@/api/datasources'
import { fetchMimicSymbols } from '@/api/mimicAssets'
import { apiErrorMessage } from '@/api/client'
import MimicCanvas, { VIEW_W, VIEW_H } from './MimicCanvas'
import DetailRail from './DetailRail'
import CameraRail from './CameraRail'
import SymbolPalette from './SymbolPalette'
import NodeInspector from './NodeInspector'
import EdgeInspector from './EdgeInspector'
import SymbolBindingDialog from './SymbolBindingDialog'
import MimicSwitcher from './MimicSwitcher'
import CustomSymbolDialog from './CustomSymbolDialog'
import MimicEditorToolbar from './MimicEditorToolbar'
import MimicCommandBar from './MimicCommandBar'
import ProductionLogDrawer from './ProductionLogDrawer'
import ProductionLogDialog from './ProductionLogDialog'
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
 * How often the drawing asks for new numbers.
 *
 * Unlike /live panels — whose interval is stored per panel and checked against
 * `VALID_POLL_INTERVALS` in panels.py — the mimic reads through /api/schema and
 * nothing on the server bounds its rate. The floor below is ours to hold.
 */
const CADENCES = [
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
]

/**
 * Behind the guard. Every poll opens a fresh libpq connection per binding
 * (`_table_source_conn`, no pool), so ten reads a second across a drawing of
 * thirty symbols is three hundred connections a second at the historian. It is
 * the right rate for commissioning one loop and the wrong one to leave running.
 */
const FAST_CADENCES = [
  { ms: 500, label: '500ms' },
  { ms: 100, label: '100ms' },
]

/** Where closing the guard puts you back. */
const GUARDED_FLOOR_MS = 1000

const CADENCE_NOTE_ID = 'mimic-cadence-note'
const PASTE_OFFSET = 24

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
 * server-side so every operator sees the same commissioned plant.
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
  const [liveMs, setLiveMs] = useState(5000)
  // The cover over the sub-second rates. Closed on every page load: an elevated
  // rate is something you choose for a job in hand, not something you inherit.
  const [fastOpen, setFastOpen] = useState(false)

  const intervalMs = liveMs
  const setIntervalMs = setLiveMs

  const {
    tags: plantTags, history, events, error: dataError, sources: connSources,
  } = usePlantData({
    nodes, pollSeconds: liveMs / 1000,
  })
  const anySourceFailed = connSources.some((s) => !s.ok)

  // Table symbols read rows, not a reading, so they poll on their own — see
  // useMimicTables for why that is a sibling rather than a branch inside the
  // value poller. The result is folded back into the same tag entries so the
  // canvas keeps one map to look things up in.
  const tableData = useMimicTables({ nodes, pollSeconds: liveMs / 1000 })
  const tags = useMemo(() => {
    const ids = Object.keys(tableData)
    if (!ids.length) return plantTags
    const merged = { ...plantTags }
    ids.forEach((id) => { merged[id] = { ...merged[id], table: tableData[id] } })
    return merged
  }, [plantTags, tableData])

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
  const copiedNodeRef = useRef(null)
  const pasteCountRef = useRef(0)
  const [editMode, setEditMode] = useState(false)
  // Local to this page, like AppShell's sidebar collapse — the rail is a
  // viewing preference for this drawing, not something worth persisting.
  const [railCollapsed, setRailCollapsed] = useState(false)
  // The hand tool, in view mode. Edit mode has `toolMode` and a toolbar to set
  // it; a running mimic has neither, so the mode lives here and on one key.
  const [viewPan, setViewPan] = useState(false)
  const [productionLogOpen, setProductionLogOpen] = useState(false)
  const [productionSettingsOpen, setProductionSettingsOpen] = useState(false)
  /**
   * Edit mode is only real when this admin is allowed to write this drawing.
   * Derived here rather than beside `lock` because it reads `editMode`, which is
   * declared with the rest of the selection state below it.
   */
  const editing = editMode && canEdit && !lock
  const dirty = !!editorSession?.dirty
  const canvasRef = useRef(null)
  // The element that goes full screen: the sheet *and* its controls, not the
  // bare <svg>. A wall display that loses the pan tool and the zoom readout the
  // moment it fills the screen is a picture, not a mimic.
  const stageRef = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)
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
    copiedNodeRef.current = null
    pasteCountRef.current = 0
    setBindingNode(null)
    setProductionLogOpen(false)
    setProductionSettingsOpen(false)
  }, [activeSlug, loadLayout])

  const selectMimic = useCallback((slug) => {
    if (!slug || slug === activeSlug) return
    setActiveSlug(slug)
    putSlugInUrl(slug)
  }, [activeSlug, putSlugInUrl])

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null
  const selectedEdge = (layout?.edges ?? []).find((e) => e.id === selectedEdgeId) ?? null
  const selectedTag = selectedId ? tags[selectedId] ?? null : null

  // Below the palette/inspector breakpoint the two rails are mutually
  // exclusive (see the toggle handlers above), so a click that selects
  // something on the canvas has to swap them itself — otherwise the
  // properties panel a symbol was just clicked *for* stays hidden behind
  // the palette, and every option in it looks like it went missing.
  const selectNode = useCallback((id) => {
    setSelectedId(id)
    setSelectedEdgeId(null)
    if (compactEditor) { setInspectorOpen(true); setPaletteOpen(false) }
  }, [compactEditor])

  const selectEdge = useCallback((id) => {
    setSelectedEdgeId(id)
    setSelectedId(null)
    if (compactEditor) { setInspectorOpen(true); setPaletteOpen(false) }
  }, [compactEditor])

  const copySelection = useCallback(() => {
    if (!selectedNode) return false
    copiedNodeRef.current = structuredClone(selectedNode)
    pasteCountRef.current = 0
    return true
  }, [selectedNode])

  const pasteSymbol = useCallback(() => {
    const copied = copiedNodeRef.current
    if (!copied) return false

    addCounter += 1
    pasteCountRef.current += 1
    const offset = PASTE_OFFSET * pasteCountRef.current
    const node = {
      ...structuredClone(copied),
      id: `n-new-${Date.now().toString(36)}-${addCounter}`,
      x: clamp(copied.x + offset, 0, VIEW_W - copied.w),
      y: clamp(copied.y + offset, 0, VIEW_H - copied.h),
    }
    commitLayout((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    selectNode(node.id)
    return true
  }, [commitLayout, selectNode])

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
    commitLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? { ...n, options: { ...n.options, ...patch } }
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

  const applyProductionLog = useCallback((binding) => {
    commitLayout((previous) => ({ ...previous, productionLog: binding }))
    setProductionSettingsOpen(false)
    notify(binding ? 'Production log settings updated in the draft.' : 'Production log removed from the draft.')
  }, [commitLayout, notify])

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
    setProductionSettingsOpen(false)
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
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.toLowerCase() !== 'h') return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      setViewPan((on) => !on)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [editing, layout])

  // Entering the editor hands panning to its own tool picker, so the view-mode
  // mode must not survive — otherwise the toolbar would read "select" while
  // the canvas still behaves like a hand.
  useEffect(() => {
    if (editing) {
      setViewPan(false)
      setProductionLogOpen(false)
    }
  }, [editing])

  useEffect(() => {
    if (!productionLogOpen || editing) return undefined
    const close = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setProductionLogOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [editing, productionLogOpen])

  /**
   * Full screen — the drawing on its own, for a control-room wall, and in edit
   * mode the whole workspace: palette, sheet and inspector.
   *
   * Both modes used to send only the canvas, which put a viewer on a wall
   * display with a drawing and no way to see what a symbol they clicked was
   * reporting — same problem the editor had with no way to add or bind a
   * symbol. `stageRef` therefore lands on the whole workspace in both modes:
   * the editor's palette/sheet/inspector grid while editing, and the
   * sheet/rail grid (`.body`) while viewing — one ref, because the two modes
   * never mount at the same time.
   *
   * The browser owns this state: Esc, F11 and the window manager can all leave
   * it without asking us. So this mirrors `document.fullscreenElement` from the
   * event rather than keeping a second opinion that could go stale. Switching
   * modes unmounts the fullscreen element, which the browser answers by exiting
   * and firing the same event, so that case needs no cleanup of its own.
   */
  useEffect(() => {
    // The null guard is load-bearing: the drawing has not mounted on the first
    // render, so an unguarded identity test compares null to null and reports
    // full screen before there is anything to show full screen.
    const sync = () => setFullscreen(
      !!stageRef.current && document.fullscreenElement === stageRef.current,
    )
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
      return
    }
    stageRef.current?.requestFullscreen?.().catch(() => {})
  }, [])

  // F, in both modes. Esc leaves — the browser insists on that and says so, so
  // there is nothing here to hold it open.
  useEffect(() => {
    if (!layout) return undefined
    const shortcut = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.toLowerCase() !== 'f') return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [layout, toggleFullscreen])

  /**
   * Where overlays open.
   *
   * A full-screen element is the only subtree the browser paints, and every
   * dialog here portals to `<body>` by default — which is outside it. Left
   * alone, "Connect data source" on a wall display opens a dialog nobody can
   * see and traps focus in it. Re-homing them into whichever element is
   * currently full screen is what makes the editor genuinely usable there.
   */
  const overlayHost = fullscreen ? stageRef.current : undefined

  const dotClass = plantStatus === 'crit' ? styles.dotCrit
    : plantStatus === 'warn' ? styles.dotWarn : ''
  // One word for the whole plant, derived once. The page header and the full
  // screen banner are two readings of the same thing and must never differ.
  const statusLabel = plantStatus === 'crit' ? 'Alarm'
    : plantStatus === 'warn' ? 'Off normal' : 'Running'

  // The sheet's width against the window onto it. Shared by both modes so the
  // reading does not change meaning when an admin clicks Edit layout.
  const viewZoom = Math.round(((layout?.viewBox?.w || VIEW_W) / viewport.w) * 100)


  const fastActive = FAST_CADENCES.some((c) => c.ms === intervalMs)
  // A rate in use is never hidden: closing the cover over the button you are
  // standing on would leave the strip claiming a rate nothing on it shows.
  const fastShown = fastOpen || fastActive

  const cadenceBtn = (c, fast) => (
    <button
      key={c.ms}
      type="button"
      className={[
        styles.cadenceBtn,
        fast ? styles.cadenceFast : '',
        intervalMs === c.ms ? styles.cadenceOn : '',
      ].filter(Boolean).join(' ')}
      aria-pressed={intervalMs === c.ms}
      onClick={() => setIntervalMs(c.ms)}
    >
      {c.label}
    </button>
  )

  const cadence = (
    <div className={styles.cadenceWrap}>
      <div
        className={`${styles.cadence} ${fastActive ? styles.cadenceElevated : ''}`}
        role="group"
        aria-label="Poll interval"
      >
        {CADENCES.map((c) => cadenceBtn(c, false))}
        {fastShown && FAST_CADENCES.map((c) => cadenceBtn(c, true))}
        <button
          type="button"
          className={styles.cadenceGuard}
          aria-expanded={fastShown}
          aria-controls={CADENCE_NOTE_ID}
          title={fastActive
            ? `Return to ${GUARDED_FLOOR_MS / 1000}s and close`
            : fastOpen ? 'Close sub-second rates' : 'Open sub-second rates'}
          onClick={() => {
            // Closing the cover puts the rate back, the way a guarded switch
            // springs shut. Leaving a plant on 100ms because a panel was tidied
            // away is exactly the outcome the guard exists to prevent.
            if (fastActive) setIntervalMs(GUARDED_FLOOR_MS)
            setFastOpen(!fastShown)
          }}
        >
          {fastShown ? '«' : '»'}
        </button>
      </div>

      {/* Anchored, so opening the guard cannot shove the page header taller. */}
      {fastShown && (
        <p className={styles.cadenceNote} id={CADENCE_NOTE_ID} role="note">
          Each poll opens one database connection per bound symbol. Use sub-second
          rates to commission a loop, then step back down.
        </p>
      )}
    </div>
  )

  /**
   * The banner full screen adds back.
   *
   * Going full screen drops the page header, and with it the first two things
   * anyone reading a mimic from across a control room needs: which plant this
   * is, and whether it is running.
   *
   * `tools` is the view-mode control cluster. It moves into this bar rather
   * than floating over the sheet, because on a wall display the drawing is the
   * whole point and every overlay is sitting on top of something an operator
   * wanted to see — in the bottom corner it covered a station's own label.
   * Between the title and the status is dead space the banner already owns.
   */
  const fullscreenHead = (tools = null) => (fullscreen ? (
    <header className={styles.fsHead}>
      <div className={styles.fsTitle}>
        <span className={styles.fsEyebrow}>Process mimic</span>
        <h2 className={styles.fsName}>{activeName}</h2>
      </div>
      {tools}
      <span className={styles.fsState}>
        <span className={`${styles.dot} ${dotClass}`} />
        {statusLabel}
      </span>
    </header>
  ) : null)

  /**
   * The view-mode control cluster: log, hand, zoom, fit, full screen.
   *
   * Defined once and rendered in one of two places — floating over the sheet
   * when windowed, inside the banner when full screen. One definition because
   * two copies would be two sets of controls to keep in step, and because only
   * one may exist in the tree at a time: they carry `aria-controls` and
   * keyboard hints that must not be duplicated.
   */
  const viewToolbar = (
    <div
      className={`${styles.viewTools} ${fullscreen ? styles.viewToolsInBanner : ''}`}
      role="group"
      aria-label="View controls"
    >
      <button
        type="button"
        className={`${styles.viewTool} ${productionLogOpen ? styles.viewToolOn : ''}`}
        aria-expanded={productionLogOpen}
        aria-controls="mimic-production-log"
        title="Production log / บันทึกผลผลิต"
        onClick={() => setProductionLogOpen((shown) => !shown)}
      >
        <BarChartOutlined fontSize="small" />
        <span className={styles.viewLogLabel}>LOG</span>
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={`${styles.viewTool} ${viewPan ? styles.viewToolOn : ''}`}
        aria-pressed={viewPan}
        aria-keyshortcuts="h"
        title="Hand tool — drag to move the drawing inside the panel (H)"
        onClick={() => setViewPan((on) => !on)}
      >
        <PanToolOutlined fontSize="small" />
        <kbd className={styles.viewKey}>H</kbd>
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={styles.viewTool}
        title="Zoom out"
        aria-label="Zoom out"
        disabled={viewZoom <= 25}
        onClick={() => canvasRef.current?.zoomOut()}
      >
        <ZoomOutOutlined fontSize="small" />
      </button>
      <output className={styles.viewZoom} aria-label="Drawing zoom">{viewZoom}%</output>
      <button
        type="button"
        className={styles.viewTool}
        title="Zoom in"
        aria-label="Zoom in"
        disabled={viewZoom >= 400}
        onClick={() => canvasRef.current?.zoomIn()}
      >
        <ZoomInOutlined fontSize="small" />
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={styles.viewTool}
        title="Fit the drawn area to the panel"
        aria-label="Fit contents"
        onClick={() => canvasRef.current?.fitContents()}
      >
        <CenterFocusStrongOutlined fontSize="small" />
      </button>
      <button
        type="button"
        className={styles.viewTool}
        title="Reset view"
        aria-label="Reset view"
        onClick={() => canvasRef.current?.resetView()}
      >
        <RestartAltOutlined fontSize="small" />
      </button>

      <span className={styles.viewDivider} />

      <button
        type="button"
        className={`${styles.viewTool} ${fullscreen ? styles.viewToolOn : ''}`}
        aria-pressed={fullscreen}
        aria-keyshortcuts="f"
        title={fullscreen ? 'Leave full screen (F or Esc)' : 'Show this mimic full screen (F)'}
        onClick={toggleFullscreen}
      >
        {fullscreen ? <FullscreenExitOutlined fontSize="small" /> : <FullscreenOutlined fontSize="small" />}
        <kbd className={styles.viewKey}>F</kbd>
      </button>
    </div>
  )

  const subtitle = nodes.length === 0
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
          {statusLabel}
        </span>

        <div className={styles.actions}>
          {cadence}

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
          ref={stageRef}
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
              <div className={styles.editorRailBody}>
                <SymbolPalette
                  onAdd={addSymbol}
                  customSymbols={customSymbols}
                  onAuthorSymbol={() => setAuthoring(true)}
                />
              </div>
            )}
          </aside>

          <main className={styles.editorCenter}>
            {/* No tools argument: edit mode has its own drafting toolbar
              * immediately below, which already carries these controls. */}
            {fullscreenHead()}
            <MimicEditorToolbar
              toolMode={toolMode}
              onToolMode={setToolMode}
              wirePen={wirePen}
              onWirePen={setWirePen}
              gridVisible={gridVisible}
              onGridVisible={setGridVisible}
              snapEnabled={snapEnabled}
              onSnapEnabled={setSnapEnabled}
              zoomPercent={viewZoom}
              onZoomOut={() => canvasRef.current?.zoomOut()}
              onZoomIn={() => canvasRef.current?.zoomIn()}
              onResetView={() => canvasRef.current?.resetView()}
              onFit={() => canvasRef.current?.fitContents()}
              fullscreen={fullscreen}
              onFullscreen={toggleFullscreen}
              onSnapshot={() => canvasRef.current?.snapshot()}
              onTogglePalette={togglePalette}
              onToggleInspector={toggleInspector}
              onProductionLog={() => setProductionSettingsOpen(true)}
              productionLogConfigured={!!layout.productionLog}
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
            {inspectorOpen && (
              <div className={styles.editorRailBody}>
                {selectedEdge ? (
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
                    onOptions={setNodeOptions}
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
                )}
              </div>
            )}
          </aside>
        </div>
      )}

      {layout && !editing && (
        <div className={`${styles.body} ${productionLogOpen ? styles.bodyLogOpen : ''}`} ref={stageRef}>
          <div className={styles.stageWrap}>
            {fullscreenHead(viewToolbar)}
            <MimicCanvas
              ref={canvasRef}
              layout={layout}
              tags={tags}
              selectedId={selectedId}
              onSelect={selectNode}
              selectedEdgeId={selectedEdgeId}
              onSelectEdge={selectEdge}
              toolMode={viewPan ? 'pan' : 'select'}
              onViewportChange={setViewport}
              onMoveNode={moveNode}
              onNudgeNode={nudgeNode}
              onResizeNode={resizeNode}
              onDeleteNode={deleteNodeKey}
              onAddEdge={addEdge}
              onDeleteEdge={deleteEdgeKey}
              onMoveBubble={moveBubble}
            />

            {/* Windowed only. In full screen the same cluster is rendered
              * into the banner above instead, so it never covers the sheet. */}
            {!fullscreen && viewToolbar}

            <ProductionLogDrawer
              open={productionLogOpen}
              slug={activeSlug}
              configured={!!layout.productionLog}
              canEdit={canEdit}
              onClose={() => setProductionLogOpen(false)}
            />
          </div>

          {/* Nothing selected means nothing to show — the rail's only content
            * is a per-symbol readout, so an empty "no asset selected" panel
            * just spends half the screen saying so. The canvas takes the
            * space back until a click gives the rail something to render. */}
          {selectedId && (
            <div className={`${styles.railCol} ${railCollapsed ? styles.railColCollapsed : ''}`}>
              <IconButton className={styles.railToggle} size="small" onClick={() => setRailCollapsed((c) => !c)}>
                {railCollapsed ? <ChevronLeft fontSize="small" /> : <ChevronRight fontSize="small" />}
              </IconButton>
              {!railCollapsed && (
                isCameraNode(selectedNode)
                  ? <CameraRail node={selectedNode} tag={selectedTag} pollMs={intervalMs} />
                  : <DetailRail tag={selectedTag} node={selectedNode} history={history[selectedId]} events={events} canBind={false} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom strip to be added with title = "สิ่งที่ต้องจัดการ"
      An empty drawing has no ticker to show;
      the bare strip would just be a box with nothing in it. */}

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
        container={overlayHost}
        onClose={() => setBindingNode(null)}
        onSave={applyBinding}
      />

      <ProductionLogDialog
        open={productionSettingsOpen}
        binding={layout?.productionLog ?? null}
        container={overlayHost}
        onClose={() => setProductionSettingsOpen(false)}
        onSave={applyProductionLog}
      />

      <CustomSymbolDialog
        open={authoring}
        container={overlayHost}
        onClose={() => setAuthoring(false)}
        onSaved={(row) => {
          queryClient.invalidateQueries({ queryKey: ['mimic-symbols'] })
          setAuthoring(false)
          notify(`“${row.name}” added to the symbol library.`)
        }}
      />

      <ImportLayoutDialog
        open={importOpen}
        container={overlayHost}
        onClose={() => setImportOpen(false)}
        onImport={importDraft}
      />
      <UnsavedChangesDialog
        open={unsavedOpen}
        container={overlayHost}
        onStay={keepEditing}
        onDiscard={discardUnsaved}
      />
      <RevisionConflictDialog
        open={conflictOpen}
        container={overlayHost}
        onContinue={() => setConflictOpen(false)}
        onExport={exportDraft}
        onReload={reloadServerRevision}
      />

      {/* Snackbar is the one overlay here that is not a modal, so it has no
        * container of its own to redirect — it is portalled explicitly for the
        * same reason the dialogs are. */}
      <Portal container={overlayHost}>
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
      </Portal>
    </div>
  )
}
