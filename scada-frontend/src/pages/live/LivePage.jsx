import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Responsive, WidthProvider } from 'react-grid-layout'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import { useAuthStore } from '@/stores/auth'
import LivePanel from '@/components/live/LivePanel'
import { fetchDevices } from '@/api/readings'
import {
  fetchPanels, createPanel, updatePanel, deletePanel, updatePollInterval,
} from '@/api/panels'
import { fetchDashboards } from '@/api/dashboards'
import { fetchDatasources } from '@/api/datasources'
import {
  layoutFromPanels, nextLayoutSlot, appendLayoutItem, panelMinSize,
  buildLayoutSavePayload, buildDuplicatePayload,
} from './panelPayload'
import PanelEditorDialog from './PanelEditorDialog'
import DashboardSwitcher from './DashboardSwitcher'
import styles from './LivePage.module.css'

// measureBeforeMount is passed as a *prop* on the wrapped component (not an
// argument to WidthProvider) — without it the grid measures 0 width on first
// paint and every tile collapses to the left edge until a resize fires.
const ResponsiveGridLayout = WidthProvider(Responsive)

const AUTO_REFRESH_MS = 5000

/**
 * LivePage — admin-managed live dashboard (route: /live).
 *
 * Renders a react-grid-layout grid of LivePanel tiles for the active
 * dashboard's panels, a dashboard switcher, edit-mode drag/resize (admin
 * only, gated to the `lg` breakpoint — see the mandatory "zero layout writes
 * below 1200px" constraint below), and Add/Edit/Duplicate/Delete panel
 * actions via PanelEditorDialog. Ported from LivePage.vue.
 *
 * Layout persists inside each panel's `options.layout = {x,y,w,h}` (no
 * backend schema change) — see panelPayload.js's layout helpers.
 */
export default function LivePage() {
  const queryClient = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? null)
  const canManage = role === 'admin'
  // Narrower than canManage: operators may change a panel's poll cadence
  // without full panel-edit rights (backed by PATCH .../poll-interval).
  const canChangePollInterval = role === 'admin' || role === 'operator'

  const [searchParams, setSearchParams] = useSearchParams()

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  const notify = useCallback((message, severity = 'success') => {
    setSnackbar({ open: true, message, severity })
  }, [])

  // --- dashboards / devices / datasources (loaded once) --------------------
  const dashboardsQuery = useQuery({ queryKey: ['dashboards'], queryFn: fetchDashboards })
  const dashboards = dashboardsQuery.data || []

  const devicesQuery = useQuery({ queryKey: ['live-devices'], queryFn: fetchDevices })
  const devices = devicesQuery.data || []
  const deviceName = useCallback((id) => devices.find((d) => d.id === id)?.name || '', [devices])

  const datasourcesQuery = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources })
  const datasources = datasourcesQuery.data || []

  // --- active dashboard resolution (?dashboard=<id>, else first board) -----
  const [activeDashboardId, setActiveDashboardId] = useState(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current || dashboardsQuery.isPending) return
    initializedRef.current = true
    const qid = Number(searchParams.get('dashboard'))
    const fromQuery = dashboards.find((d) => d.id === qid)
    const next = fromQuery ? fromQuery.id : (dashboards[0]?.id ?? null)
    setActiveDashboardId(next)
    if (next != null) {
      const p = new URLSearchParams(searchParams)
      p.set('dashboard', String(next))
      setSearchParams(p, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardsQuery.isPending, dashboards])

  // If the active board disappears (deleted elsewhere), fall back to the
  // first remaining one. Never runs before the initial resolution above.
  useEffect(() => {
    if (!initializedRef.current) return
    if (!dashboards.length) { setActiveDashboardId(null); return }
    if (activeDashboardId != null && dashboards.some((d) => d.id === activeDashboardId)) return
    const next = dashboards[0].id
    setActiveDashboardId(next)
    const p = new URLSearchParams(searchParams)
    p.set('dashboard', String(next))
    setSearchParams(p, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboards])

  function selectDashboard(id) {
    if (id == null || id === activeDashboardId) return
    setActiveDashboardId(id)
    setEditMode(false)
    const p = new URLSearchParams(searchParams)
    p.set('dashboard', String(id))
    setSearchParams(p, { replace: true })
  }

  // --- panels for the active dashboard --------------------------------------
  const panelsQuery = useQuery({
    queryKey: ['live-panels', activeDashboardId],
    queryFn: () => fetchPanels(activeDashboardId),
    enabled: activeDashboardId != null,
  })
  const panels = panelsQuery.data || []

  function patchPanels(updater) {
    queryClient.setQueryData(['live-panels', activeDashboardId], (old) => (old ? updater(old) : old))
  }

  // --- react-grid-layout geometry -------------------------------------------
  // Rebuilt from panels.options.layout exactly once per dashboard switch (via
  // layoutDashboardRef), never on a background panels refetch for the SAME
  // board — that would clobber an in-progress, unsaved edit-mode drag.
  const [layout, setLayout] = useState([])
  const layoutDashboardRef = useRef(undefined)

  useEffect(() => {
    if (activeDashboardId == null) { setLayout([]); layoutDashboardRef.current = undefined; return }
    if (panelsQuery.isPending) return
    if (layoutDashboardRef.current === activeDashboardId) return
    layoutDashboardRef.current = activeDashboardId
    setLayout(layoutFromPanels(panels))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDashboardId, panelsQuery.isPending, panels])

  // Per-item drag/resize floor, computed fresh each render from the current
  // panels list (min size depends on chart_type + series count).
  const gridLayouts = useMemo(() => {
    const withConstraints = layout.map((it) => {
      const panel = panels.find((p) => String(p.id) === it.i)
      const min = panelMinSize(panel)
      return { ...it, minW: min.w, minH: min.h }
    })
    return { lg: withConstraints }
  }, [layout, panels])

  // --- lg-only breakpoint gate (mandatory: zero layout writes below 1200px) -
  // RGL's Responsive fires onBreakpointChange synchronously before
  // onLayoutChange within the same internal handler, so a ref (not state,
  // which batches) is required to gate saveLayout()'s guard correctly.
  const breakpointRef = useRef('lg')
  const [breakpoint, setBreakpointState] = useState('lg')
  function handleBreakpointChange(newBp) {
    breakpointRef.current = newBp
    setBreakpointState(newBp)
  }
  useEffect(() => {
    if (breakpoint !== 'lg') setEditMode(false)
  }, [breakpoint])

  function handleLayoutChange(newLayout) {
    // Fires on every drag/resize tick — local React state only, never a
    // network write (that only ever happens inside saveLayout()).
    setLayout(newLayout.map((it) => ({
      i: it.i, x: it.x, y: it.y, w: it.w, h: it.h,
    })))
  }

  // --- edit mode / layout persistence ---------------------------------------
  const [editMode, setEditMode] = useState(false)
  const [savingLayout, setSavingLayout] = useState(false)

  async function saveLayout(layoutToSave) {
    if (breakpointRef.current !== 'lg') return // hard guard, see risk note above
    if (!canManage) return
    const dirty = []
    for (const item of layoutToSave) {
      const panel = panels.find((p) => String(p.id) === item.i)
      if (!panel) continue
      const cur = panel.options?.layout || {}
      if (cur.x === item.x && cur.y === item.y && cur.w === item.w && cur.h === item.h) continue
      dirty.push({ panel, layout: { x: item.x, y: item.y, w: item.w, h: item.h } })
    }
    if (!dirty.length) return
    setSavingLayout(true)
    try {
      const updated = await Promise.all(
        dirty.map(({ panel, layout: lay }) => updatePanel(panel.id, buildLayoutSavePayload(panel, lay, activeDashboardId))),
      )
      const byId = new Map(updated.map((u) => [u.id, u]))
      patchPanels((old) => old.map((p) => byId.get(p.id) || p))
      notify('Layout saved.')
    } catch (e) {
      notify(e?.response?.data?.detail || 'Failed to save layout.', 'error')
    } finally {
      setSavingLayout(false)
    }
  }

  function toggleEditMode() {
    if (breakpointRef.current !== 'lg') return // can't even enter edit mode below lg
    if (editMode) {
      setEditMode(false)
      saveLayout(layout)
    } else {
      setEditMode(true)
    }
  }

  // --- manual + background auto-refresh -------------------------------------
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  function refreshAll() {
    setRefreshing(true)
    setRefreshSignal(Date.now())
    setTimeout(() => setRefreshing(false), 700)
  }

  useEffect(() => {
    // StrictMode-safe: the id is a local const captured by this exact effect
    // invocation and cleared by the matching cleanup — never a ref reused
    // across renders/remounts.
    const id = setInterval(() => setRefreshSignal(Date.now()), AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const [lastUpdatedAt, setLastUpdatedAt] = useState(0)
  const handlePanelUpdated = useCallback((ts) => {
    setLastUpdatedAt((prev) => (ts > prev ? ts : prev))
  }, [])
  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return ''
    const d = new Date(lastUpdatedAt)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `${date} ${d.toLocaleTimeString()}`
  }, [lastUpdatedAt])

  // --- panel editor dialog ---------------------------------------------------
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingPanel, setEditingPanel] = useState(null)
  function openCreate() { setEditingPanel(null); setEditorOpen(true) }
  function openEdit(panel) { setEditingPanel(panel); setEditorOpen(true) }

  function handlePanelSaved(panel, isNew) {
    patchPanels((old) => (isNew ? [...old, panel] : old.map((p) => (p.id === panel.id ? panel : p))))
    if (isNew) setLayout((prev) => appendLayoutItem(prev, panel))
    notify(isNew ? 'Panel added.' : 'Panel updated.')
  }

  // --- duplicate panel --------------------------------------------------------
  const [duplicateTarget, setDuplicateTarget] = useState(null)
  const [duplicateTitle, setDuplicateTitle] = useState('')
  const [duplicateError, setDuplicateError] = useState('')
  const [duplicating, setDuplicating] = useState(false)

  function openDuplicate(panel) {
    setDuplicateError('')
    setDuplicateTarget(panel)
    setDuplicateTitle(`${panel.title} (Copy)`)
  }

  async function confirmDuplicate() {
    const title = duplicateTitle.trim()
    if (!title) { setDuplicateError('Name is required.'); return }
    setDuplicating(true)
    try {
      const payload = buildDuplicatePayload(duplicateTarget, title, {
        activeDashboardId, panelsLength: panels.length, nextLayout: nextLayoutSlot(layout),
      })
      const created = await createPanel(payload)
      patchPanels((old) => [...old, created])
      setLayout((prev) => appendLayoutItem(prev, created))
      notify('Panel duplicated.')
      setDuplicateTarget(null)
    } catch (e) {
      setDuplicateError(e?.response?.data?.detail || 'Failed to duplicate panel.')
    } finally {
      setDuplicating(false)
    }
  }

  // --- delete panel -------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

  function openDelete(panel) {
    setDeleteError('')
    setDeleteTarget(panel)
  }

  async function confirmDelete() {
    const panel = deleteTarget
    if (!panel) return
    setDeleting(true)
    try {
      await deletePanel(panel.id)
      patchPanels((old) => old.filter((p) => p.id !== panel.id))
      setLayout((prev) => prev.filter((it) => it.i !== String(panel.id)))
      notify('Panel deleted.')
      setDeleteTarget(null)
    } catch (e) {
      setDeleteError(e?.response?.data?.detail || 'Failed to delete panel.')
    } finally {
      setDeleting(false)
    }
  }

  // --- per-panel poll interval (operators may do this too) ----------------------
  async function handlePollIntervalChange(panel, seconds) {
    if (!canChangePollInterval) return
    try {
      const updated = await updatePollInterval(panel.id, seconds)
      patchPanels((old) => old.map((p) => (p.id === updated.id ? updated : p)))
    } catch (e) {
      notify(e?.response?.data?.detail || 'Failed to update poll interval.', 'error')
    }
  }

  const loading = dashboardsQuery.isPending || (activeDashboardId != null && panelsQuery.isPending)
  const loadError = dashboardsQuery.error || panelsQuery.error

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={styles.titleWrap}>
          <DashboardSwitcher
            dashboards={dashboards}
            activeDashboardId={activeDashboardId}
            switching={panelsQuery.isFetching}
            canManage={canManage}
            onSelect={selectDashboard}
          />
          <p className={styles.sub}>Real-time machine panels · per-panel poll interval</p>
        </div>

        <div className={styles.clock}>
          {lastUpdatedLabel && <span className={styles.updated}>Updated : {lastUpdatedLabel}</span>}
        </div>

        <div className={styles.actions}>
          <Button startIcon={<RefreshIcon />} loading={refreshing} disabled={!panels.length} onClick={refreshAll}>
            Refresh
          </Button>
          {canManage && panels.length > 0 && (
            <Button
              variant={editMode ? 'contained' : 'outlined'}
              color={editMode ? 'success' : 'inherit'}
              disabled={breakpoint !== 'lg'}
              title={breakpoint !== 'lg' ? 'Edit layout is only available at desktop widths (≥1200px)' : ''}
              loading={savingLayout}
              onClick={toggleEditMode}
            >
              {editMode ? 'Done' : 'Edit Layout'}
            </Button>
          )}
          {canManage && (
            <Button variant="contained" startIcon={<AddIcon />} disabled={activeDashboardId == null} onClick={openCreate}>
              Add panel
            </Button>
          )}
        </div>
      </header>

      {loadError && (
        <Alert severity="error">
          {loadError?.response?.data?.detail || loadError?.message || 'Failed to load dashboard.'}
        </Alert>
      )}

      {!loadError && loading && <p className={styles.empty}>Loading panels…</p>}

      {!loadError && !loading && !panels.length && (
        <p className={styles.empty}>
          No panels yet. {canManage ? 'Click "Add panel" to create one.' : "An admin hasn't configured any panels."}
        </p>
      )}

      {!loadError && !loading && panels.length > 0 && (
        <ResponsiveGridLayout
          className={`${styles.grid} ${editMode ? styles.gridEditing : ''}`}
          layouts={gridLayouts}
          cols={{
            lg: 12, md: 12, sm: 1, xs: 1, xxs: 1,
          }}
          breakpoints={{
            lg: 1200, md: 900, sm: 700, xs: 480, xxs: 0,
          }}
          rowHeight={26}
          margin={[16, 16]}
          isDraggable={editMode && canManage}
          isResizable={editMode && canManage}
          verticalCompact
          useCSSTransforms
          draggableHandle=".panel__drag"
          measureBeforeMount
          onBreakpointChange={handleBreakpointChange}
          onLayoutChange={handleLayoutChange}
        >
          {layout.map((item) => {
            const panel = panels.find((p) => String(p.id) === item.i)
            if (!panel) return null
            return (
              <div key={item.i}>
                <LivePanel
                  panel={panel}
                  deviceName={deviceName(panel.device_id)}
                  canManage={canManage}
                  canChangePollInterval={canChangePollInterval}
                  editMode={editMode}
                  refreshSignal={refreshSignal}
                  onEdit={openEdit}
                  onDuplicate={openDuplicate}
                  onDelete={openDelete}
                  onPollIntervalChange={handlePollIntervalChange}
                  onUpdated={handlePanelUpdated}
                />
              </div>
            )
          })}
        </ResponsiveGridLayout>
      )}

      <PanelEditorDialog
        open={editorOpen}
        editingPanel={editingPanel}
        activeDashboardId={activeDashboardId}
        panelsLength={panels.length}
        nextLayout={nextLayoutSlot(layout)}
        datasources={datasources}
        onClose={() => setEditorOpen(false)}
        onSaved={handlePanelSaved}
      />

      {/* Duplicate panel: small centred form */}
      <Dialog open={!!duplicateTarget} onClose={() => setDuplicateTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Duplicate panel</DialogTitle>
        <DialogContent className={styles.smallDialogContent}>
          <TextField
            autoFocus
            fullWidth
            label="New panel name"
            placeholder="e.g. Boiler #1 Temperature (Copy)"
            value={duplicateTitle}
            onChange={(e) => setDuplicateTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmDuplicate() }}
          />
          {duplicateTarget && (
            <p className={styles.hint}>
              Copies all settings from <strong>{duplicateTarget.title}</strong>.
            </p>
          )}
          {duplicateError && <Alert severity="error">{duplicateError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicateTarget(null)}>Cancel</Button>
          <Button variant="contained" loading={duplicating} onClick={confirmDuplicate}>Create</Button>
        </DialogActions>
      </Dialog>

      {/* Delete panel: small centred confirm */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete panel</DialogTitle>
        <DialogContent className={styles.smallDialogContent}>
          {deleteTarget && <p>Delete <strong>{deleteTarget.title}</strong>?</p>}
          <p className={styles.hint}>This action cannot be undone.</p>
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </DialogActions>
      </Dialog>

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
