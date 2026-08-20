import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import BoltOutlined from '@mui/icons-material/BoltOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import { useAuthStore } from '@/stores/auth'
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
import WirePicker from './WirePicker'
import SymbolBindingDialog from './SymbolBindingDialog'
import MimicSwitcher from './MimicSwitcher'
import CustomSymbolDialog from './CustomSymbolDialog'
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

  const [layout, setLayout] = useState(null)
  const legacyPendingRef = useRef(false)
  // Which slug the drawing on screen belongs to. Without this the seed guard
  // below would read "have I seeded anything?" and a switch would keep showing
  // the previous plant under the new plant's name.
  const seededSlugRef = useRef(null)

  useEffect(() => {
    if (!activeSlug || seededSlugRef.current === activeSlug || layoutQuery.isPending) return
    const server = layoutQuery.data?.doc ? migrateLayout(layoutQuery.data.doc) : null
    seededSlugRef.current = activeSlug
    if (server) { setLayout(server); return }
    // Nothing on the server. An admin may still have a hand-arranged drawing
    // in this browser from before /monitor had a backend — carry its geometry
    // into the first save rather than replacing it with the seed. It belongs
    // to one plant, so only that plant's slug may claim it.
    if (activeSlug === FALLBACK_SLUG) {
      const legacy = readLegacyLayout()
      if (legacy) {
        legacyPendingRef.current = true
        setLayout(legacy)
        return
      }
      setLayout(seedLayout())
      return
    }
    setLayout(emptyLayout(layouts.find((l) => l.slug === activeSlug)?.name ?? activeSlug))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug, layoutQuery.isPending, layoutQuery.data])

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
    tags, history, events, error: dataError, simulateExcursion, excursionTag,
  } = usePlantData({
    nodes, demo, tickMs, pollSeconds,
  })

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
  /**
   * Edit mode is only real when this admin is allowed to write this drawing.
   * Derived here rather than beside `lock` because it reads `editMode`, which is
   * declared with the rest of the selection state below it.
   */
  const editing = editMode && canEdit && !lock
  const [bindingNode, setBindingNode] = useState(null)
  // The upload/author flow. Not per-node: a library symbol is authored once
  // and then placed, so this is a property of the session, not of a selection.
  const [authoring, setAuthoring] = useState(false)

  // Switching drawings: nothing from the old one survives. Every id here names
  // a node or pipe that is about to stop existing, and the binding dialog in
  // particular would otherwise write its result into the plant next door.
  useEffect(() => {
    if (seededSlugRef.current === null || seededSlugRef.current === activeSlug) return
    seededSlugRef.current = null
    setLayout(null)
    setSelectedId(null)
    setSelectedEdgeId(null)
    setBindingNode(null)
  }, [activeSlug])

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
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...pos } : n)),
    }))
  }, [])

  // Resolved against the node in `prev` rather than the rendered one so a
  // burst of key repeats accumulates instead of collapsing to the last one.
  const nudgeNode = useCallback((id, dx, dy) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? {
          ...n,
          x: clamp(n.x + dx, 0, VIEW_W - n.w),
          y: clamp(n.y + dy, 0, VIEW_H - n.h),
        }
        : n)),
    }))
  }, [])

  // Ports are fractions of the node box and edge geometry is never stored, so
  // a resize re-routes every wire on the symbol for free. The canvas has
  // already snapped and clamped the box.
  const resizeNode = useCallback((id, box) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...box } : n)),
    }))
  }, [])

  // Rotation was already wired end to end on the canvas — the transform is
  // applied and resizeBox un-rotates pointer deltas — with nothing to set it.
  // Stored in degrees, normalised so a rotated symbol reports 15° rather than 375°.
  const rotateNode = useCallback((id, deg) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? { ...n, rot: ((Math.round(deg) % 360) + 360) % 360 }
        : n)),
    }))
  }, [])

  // Back to the size the symbol was drawn at. Position is left alone: the
  // symbol is where the engineer put it, and only its size was in question.
  const resetNodeSize = useCallback((id) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id
        ? { ...n, ...(symbolDef(n)?.defaultSize ?? { w: n.w, h: n.h }) }
        : n)),
    }))
  }, [])

  // Deleting a node takes its wires with it — an edge whose endpoint is gone
  // has no geometry to derive.
  const deleteNode = useCallback((id) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== id),
      edges: prev.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    }))
    setSelectedId(null)
    // One of the pipes that just went with it may have been the selection.
    setSelectedEdgeId(null)
  }, [])

  // --- balloon placement ---------------------------------------------------
  // Stored as an offset from the symbol's own anchor, so a repositioned
  // reading follows its equipment the next time that equipment is dragged.
  const moveBubble = useCallback((id, offset) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, bubble: { offset } } : n)),
    }))
  }, [])

  const resetBubble = useCallback((id) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, bubble: null } : n)),
    }))
  }, [])

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
    setLayout((prev) => ({
      ...prev,
      edges: [...prev.edges, {
        id, ...ends, service: wirePen, flowNode: null,
      }],
    }))
    selectEdge(id)
  }, [layout, notify, selectEdge, wirePen])

  // Correcting one wire's type in the inspector also picks up the pen: you
  // reached for that line because it was the one you meant, and the next
  // segment of the same run almost always wants it too.
  const updateEdge = useCallback((id, patch) => {
    if (patch.service) setWirePen(patch.service)
    setLayout((prev) => ({
      ...prev,
      edges: prev.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))
  }, [])

  const deleteEdge = useCallback((id) => {
    setLayout((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== id) }))
    setSelectedEdgeId(null)
  }, [])

  /**
   * Drop a new symbol at the centre of the sheet.
   *
   * `symbolId` names a library entry and is only meaningful for `custom`. It has
   * to be on the node from the moment it is created — the size and ports come off
   * that entry, so a custom node without one would be placed at the generic
   * fallback size and then jump when it resolved.
   */
  const addSymbol = useCallback((type, symbolId = null) => {
    const def = symbolDef({ type, symbolId }) ?? SYMBOLS[type]
    addCounter += 1
    const id = `n-new-${Date.now().toString(36)}-${addCounter}`
    const node = {
      id,
      type,
      ...(symbolId == null ? {} : { symbolId }),
      tagId: null,
      binding: null,
      label: def.label,
      x: Math.round((VIEW_W - def.defaultSize.w) / 2),
      y: Math.round((VIEW_H - def.defaultSize.h) / 2),
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      rot: 0,
    }
    setLayout((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    selectNode(id)
  }, [selectNode])

  // --- persistence ---------------------------------------------------------
  const [saving, setSaving] = useState(false)

  const persist = useCallback(async (doc) => {
    setSaving(true)
    try {
      await saveMimicLayout(activeSlug, doc.name || activeName, doc)
      if (legacyPendingRef.current) {
        clearLegacyLayout()
        legacyPendingRef.current = false
      }
      // On a fresh install this PUT is what puts the fallback plant in the
      // table for the first time, so the switcher's list is now out of date.
      queryClient.invalidateQueries({ queryKey: ['mimic-layouts'] })
      notify('Layout saved.')
      return true
    } catch (e) {
      notify(apiErrorMessage(e, 'Failed to save the layout.'), 'error')
      return false
    } finally {
      setSaving(false)
    }
  }, [activeName, activeSlug, notify, queryClient])

  // The rail's Remove buttons defer to Done like any other edit (drag,
  // resize, wiring) — geometry is provisional until you let go of the whole
  // session. The keyboard shortcut has no such session to leave: Delete is a
  // one-shot action with nothing else on screen to say "not saved yet", so it
  // writes through immediately or a refresh (or switching drawings) silently
  // brings the symbol back.
  const deleteNodeKey = useCallback((id) => {
    const next = {
      ...layout,
      nodes: layout.nodes.filter((n) => n.id !== id),
      edges: layout.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    }
    setLayout(next)
    setSelectedId(null)
    setSelectedEdgeId(null)
    persist(next)
  }, [layout, persist])

  const deleteEdgeKey = useCallback((id) => {
    const next = { ...layout, edges: layout.edges.filter((e) => e.id !== id) }
    setLayout(next)
    setSelectedEdgeId(null)
    persist(next)
  }, [layout, persist])

  // --- binding dialog ------------------------------------------------------
  const openBinding = useCallback((node) => setBindingNode(node), [])

  const applyBinding = useCallback(({ tagId, label, binding }) => {
    const next = {
      ...layout,
      nodes: layout.nodes.map((n) => (n.id === bindingNode.id
        ? { ...n, tagId, label, binding }
        : n)),
    }
    setLayout(next)
    setBindingNode(null)
    // Commissioning a loop publishes straight away. Geometry waits for Done
    // because a drag is provisional until you let go of it, but a binding is a
    // decision — and an admin who rebinds from the read-only rail never enters
    // edit mode at all, so there would otherwise be nothing to save it with.
    if (editMode) {
      notify(binding ? 'Binding set. Saved when you leave edit mode.' : 'Symbol disconnected.')
    } else {
      persist(next)
    }
  }, [bindingNode, editMode, layout, notify, persist])

  const toggleEdit = useCallback(() => {
    if (editMode) {
      persist(layout)
      setEditMode(false)
      // The read-only rail has no inspector for a pipe, so a pipe left
      // selected on the way out would simply vanish from the page.
      setSelectedEdgeId(null)
    } else {
      setEditMode(true)
    }
  }, [editMode, layout, persist])

  // "Back to how this drawing started" — which is the seeded steam skid for
  // the plant /monitor shipped with, and a blank sheet for one an admin drew.
  const handleReset = useCallback(() => {
    setLayout(activeSlug === FALLBACK_SLUG ? seedLayout() : emptyLayout(activeName))
    setSelectedId(null)
    setSelectedEdgeId(null)
  }, [activeName, activeSlug])

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
            // Geometry is provisional until Done, so it lives only in local
            // state. Switching away would throw it out with no way back.
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
            <>
              {editMode && (
                <Button startIcon={<RestartAltOutlined />} color="inherit" onClick={handleReset}>
                  Reset layout
                </Button>
              )}
              <Button
                variant={editMode ? 'contained' : 'outlined'}
                color={editMode ? 'success' : 'inherit'}
                loading={saving}
                onClick={toggleEdit}
              >
                {editMode ? 'Done' : 'Edit layout'}
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Read-only, and why. Sits above the data error because it describes
        * the drawing itself rather than this tick's poll. */}
      {lock && <Alert severity="warning">{lock}</Alert>}

      {dataError && <Alert severity="warning">{dataError}</Alert>}

      {/* Only the drawing waits on the switch — the switcher itself stays put,
        * so the control you just used does not vanish under your cursor. */}
      {!layout && <p className={styles.loading}>Loading the plant drawing…</p>}

      {layout && (
      <div className={styles.body}>
        <MimicCanvas
          layout={layout}
          tags={tags}
          selectedId={selectedId}
          onSelect={selectNode}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={selectEdge}
          editMode={editing}
          wirePen={wirePen}
          onMoveNode={moveNode}
          onNudgeNode={nudgeNode}
          onResizeNode={resizeNode}
          onDeleteNode={deleteNodeKey}
          onAddEdge={addEdge}
          onDeleteEdge={deleteEdgeKey}
          onMoveBubble={moveBubble}
          onOpenBinding={canEdit && !lock ? openBinding : undefined}
        />

        {/* The rail stacks the pen above whatever the selection calls for.
          * The pen stays put for the whole edit session because it is state
          * you draw *in*, not a property of the thing you have selected. */}
        <div className={styles.rail}>
          {editing && <WirePicker value={wirePen} onChange={setWirePen} />}

          {editing
            ? (selectedEdge
              ? (
                <EdgeInspector
                  edge={selectedEdge}
                  nodes={nodes}
                  onChange={(patch) => updateEdge(selectedEdge.id, patch)}
                  onDelete={deleteEdge}
                  onBack={() => setSelectedEdgeId(null)}
                />
              )
              : selectedNode
                ? (
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
                )
                : (
                  <SymbolPalette
                    onAdd={addSymbol}
                    customSymbols={customSymbols}
                    onAuthorSymbol={() => setAuthoring(true)}
                  />
                ))
            : (
              <DetailRail
                tag={selectedTag}
                node={selectedNode}
                history={selectedId ? history[selectedId] : null}
                events={events}
                canBind={canEdit && !lock}
                onConnect={openBinding}
              />
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
