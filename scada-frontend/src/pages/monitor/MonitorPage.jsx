import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import BoltOutlined from '@mui/icons-material/BoltOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import { useAuthStore } from '@/stores/auth'
import usePlantData from '@/components/mimic/usePlantData'
import { SYMBOLS } from '@/components/mimic/symbols'
import { formatValue, worseStatus } from '@/components/mimic/tagStatus'
import { fetchMimicLayout, saveMimicLayout } from '@/api/mimic'
import { fetchDatasources } from '@/api/datasources'
import MimicCanvas, { VIEW_W, VIEW_H } from './MimicCanvas'
import DetailRail from './DetailRail'
import SymbolPalette from './SymbolPalette'
import NodeInspector from './NodeInspector'
import SymbolBindingDialog from './SymbolBindingDialog'
import {
  migrateLayout, readLegacyLayout, clearLegacyLayout, seedLayout,
} from './layoutDoc'
import styles from './MonitorPage.module.css'

const PLANT_SLUG = 'boiler-1'

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

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  const notify = useCallback((message, severity = 'success') => {
    setSnackbar({ open: true, message, severity })
  }, [])

  // --- layout: server is the source of truth ------------------------------
  const layoutQuery = useQuery({
    queryKey: ['mimic-layout', PLANT_SLUG],
    queryFn: () => fetchMimicLayout(PLANT_SLUG),
    // 404 is the normal first-run answer, not a failure to retry.
    retry: (count, err) => err?.response?.status !== 404 && count < 2,
  })

  const [layout, setLayout] = useState(null)
  const legacyPendingRef = useRef(false)

  useEffect(() => {
    if (layout || layoutQuery.isPending) return
    const server = layoutQuery.data?.doc ? migrateLayout(layoutQuery.data.doc) : null
    if (server) { setLayout(server); return }
    // Nothing on the server. An admin may still have a hand-arranged drawing
    // in this browser from before /monitor had a backend — carry its geometry
    // into the first save rather than replacing it with the seed.
    const legacy = readLegacyLayout()
    if (legacy) {
      legacyPendingRef.current = true
      setLayout(legacy)
      return
    }
    setLayout(seedLayout())
  }, [layout, layoutQuery.isPending, layoutQuery.data])

  const nodes = useMemo(() => layout?.nodes ?? [], [layout])

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
  const [selectedId, setSelectedId] = useState(null)
  const [editMode, setEditMode] = useState(false)

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null
  const selectedTag = selectedId ? tags[selectedId] ?? null : null

  const selectNode = useCallback((id) => setSelectedId(id), [])

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

  // Deleting a node takes its pipes with it — an edge whose endpoint is gone
  // has no geometry to derive.
  const deleteNode = useCallback((id) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== id),
      edges: prev.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    }))
    setSelectedId(null)
  }, [])

  const addSymbol = useCallback((type) => {
    const def = SYMBOLS[type]
    addCounter += 1
    const id = `n-new-${Date.now().toString(36)}-${addCounter}`
    const node = {
      id,
      type,
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
    setSelectedId(id)
  }, [])

  // --- persistence ---------------------------------------------------------
  const [saving, setSaving] = useState(false)

  const persist = useCallback(async (doc) => {
    setSaving(true)
    try {
      await saveMimicLayout(PLANT_SLUG, doc.name || 'Boiler House 1', doc)
      if (legacyPendingRef.current) {
        clearLegacyLayout()
        legacyPendingRef.current = false
      }
      notify('Layout saved.')
      return true
    } catch (e) {
      notify(e?.response?.data?.detail || 'Failed to save the layout.', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }, [notify])

  // --- binding dialog ------------------------------------------------------
  const [bindingNode, setBindingNode] = useState(null)

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
    } else {
      setEditMode(true)
    }
  }, [editMode, layout, persist])

  const handleReset = useCallback(() => {
    setLayout(seedLayout())
    setSelectedId(null)
  }, [])

  const dotClass = plantStatus === 'crit' ? styles.dotCrit
    : plantStatus === 'warn' ? styles.dotWarn : ''

  if (!layout) {
    return <p className={styles.loading}>Loading the plant drawing…</p>
  }

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
    ? 'Steam skid · simulated process · no datasource'
    : connected === 0
      ? 'Steam skid · no symbols connected yet'
      : `Steam skid · ${connected} of ${nodes.length} symbols connected · ${backendCount} ${backendCount === 1 ? 'connection' : 'connections'}`

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={styles.titleWrap}>
          <h2 className={styles.title}>{layout.name || 'Boiler House 1'}</h2>
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

          {canEdit && (
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

      {dataError && <Alert severity="warning">{dataError}</Alert>}

      <div className={styles.body}>
        <MimicCanvas
          layout={layout}
          tags={tags}
          selectedId={selectedId}
          onSelect={selectNode}
          editMode={editMode && canEdit}
          onMoveNode={moveNode}
          onNudgeNode={nudgeNode}
          onDeleteNode={deleteNode}
          onOpenBinding={canEdit ? openBinding : undefined}
        />

        {editMode && canEdit
          ? (selectedNode
            ? (
              <NodeInspector
                node={selectedNode}
                datasources={datasourcesQuery.data || []}
                onConnect={() => openBinding(selectedNode)}
                onDelete={deleteNode}
                onBack={() => setSelectedId(null)}
              />
            )
            : <SymbolPalette onAdd={addSymbol} />)
          : (
            <DetailRail
              tag={selectedTag}
              node={selectedNode}
              history={selectedId ? history[selectedId] : null}
              events={events}
              canBind={canEdit}
              onConnect={openBinding}
            />
          )}
      </div>

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

      <SymbolBindingDialog
        open={!!bindingNode}
        node={bindingNode}
        onClose={() => setBindingNode(null)}
        onSave={applyBinding}
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
