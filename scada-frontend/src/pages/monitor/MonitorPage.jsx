import { useCallback, useEffect, useRef } from 'react'
import Alert from '@mui/material/Alert'
import { useAuthStore } from '@/stores/auth'
import ConnectionAlarmStrip from '@/components/ConnectionAlarm/ConnectionAlarmStrip'
import KpiStrip from './KpiStrip'
import { VIEW_W } from './sheet'
import useNotify from './hooks/useNotify'
import useMonitorUi from './hooks/useMonitorUi'
import useMimicDrawings from './hooks/useMimicDrawings'
import useMimicDocument from './hooks/useMimicDocument'
import useMimicData from './hooks/useMimicData'
import useEditorChrome from './hooks/useEditorChrome'
import useMimicSelection from './hooks/useMimicSelection'
import useLayoutEdits from './hooks/useLayoutEdits'
import useDialogActions from './hooks/useDialogActions'
import useEditLifecycle from './hooks/useEditLifecycle'
import useMimicFiles from './hooks/useMimicFiles'
import useFullscreen from './hooks/useFullscreen'
import useEditorShortcuts from './hooks/useEditorShortcuts'
import OverviewPanel from './view/OverviewPanel'
import ViewToolbar from './view/ViewToolbar'
import FullscreenHead from './view/FullscreenHead'
import MimicEditor from './view/MimicEditor'
import MimicViewer from './view/MimicViewer'
import AttentionStrip from './view/AttentionStrip'
import MonitorDialogs from './view/MonitorDialogs'
import styles from './MonitorPage.module.css'

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
 *
 * This file only composes. Where things live:
 *   hooks/    state and effects, one concern each — which drawing is open
 *             (useMimicDrawings), its document and saving (useMimicDocument),
 *             live data (useMimicData), selection (useMimicSelection), edits
 *             (useLayoutEdits), dialog results (useDialogActions), the edit
 *             session's life cycle (useEditLifecycle), files, full screen,
 *             shortcuts.
 *   view/     presentational components: the overview, the two modes
 *             (MimicViewer / MimicEditor), the dialogs.
 *   layoutOps.js, monitorStatus.js — the pure logic, unit-tested.
 * The hooks are called in dependency order: drawings → document → data →
 * selection → edits → lifecycle.
 */
export default function MonitorPage() {
  const canEdit = useAuthStore((s) => s.user?.role ?? null) === 'admin'
  const canvasRef = useRef(null)

  const { snackbar, notify, closeSnackbar } = useNotify()
  const ui = useMonitorUi()
  const { setConflictOpen } = ui

  const { layouts, activeSlug, selectMimic } = useMimicDrawings()

  const onConflict = useCallback(() => setConflictOpen(true), [setConflictOpen])
  const doc = useMimicDocument({
    activeSlug, layouts, notify, onConflict,
  })
  const {
    layout, nodes, kpis, lock, activeName,
  } = doc

  const data = useMimicData({ nodes, kpis })
  const { tags } = data

  const chrome = useEditorChrome()
  const selection = useMimicSelection({
    nodes,
    edges: layout?.edges ?? [],
    tags,
    onReveal: chrome.revealInspector,
  })
  const edits = useLayoutEdits({
    layout,
    commitLayout: doc.commitLayout,
    previewLayout: doc.previewLayout,
    selection,
    notify,
    snapEnabled: chrome.snapEnabled,
    wirePen: chrome.wirePen,
    setWirePen: chrome.setWirePen,
  })
  const actions = useDialogActions({
    layout, commitLayout: doc.commitLayout, kpis, ui, notify,
  })
  const lifecycle = useEditLifecycle({
    canEdit, activeSlug, doc, selection, ui,
  })
  const { editing, editMode } = lifecycle
  const files = useMimicFiles({
    layout,
    activeSlug,
    activeName,
    customSymbols: data.customSymbols,
    commitLayout: doc.commitLayout,
    notify,
    setSelectedId: selection.setSelectedId,
    setSelectedEdgeId: selection.setSelectedEdgeId,
    setImportOpen: ui.setImportOpen,
  })
  const {
    stageRef, fullscreen, toggleFullscreen, overlayHost,
  } = useFullscreen()

  useEditorShortcuts({
    editing,
    layout,
    dirty: doc.dirty,
    saving: doc.saving,
    handleSave: lifecycle.handleSave,
    copySelection: selection.copySelection,
    pasteSymbol: edits.pasteSymbol,
    undoLayout: doc.undoLayout,
    redoLayout: doc.redoLayout,
    deleteSelection: edits.deleteSelection,
    nudgeNode: edits.nudgeNode,
    selectedId: selection.selectedId,
    selectedEdgeId: selection.selectedEdgeId,
    productionLogOpen: ui.productionLogOpen,
    setProductionLogOpen: ui.setProductionLogOpen,
    setViewPan: ui.setViewPan,
    toggleFullscreen,
  })

  // Switching drawings: nothing from the old one survives. Every id here names
  // a node or pipe that is about to stop existing, and the binding dialog in
  // particular would otherwise write its result into the plant next door.
  // Declared after useMimicDocument's seed effect on purpose — see there.
  const { seededSlugRef, loadLayout } = doc
  const { setSelectedId, setSelectedEdgeId, resetClipboard } = selection
  const { setBindingNode, setProductionLogOpen, setProductionSettingsOpen } = ui
  useEffect(() => {
    if (seededSlugRef.current === null || seededSlugRef.current === activeSlug) return
    seededSlugRef.current = null
    loadLayout(null)
    setSelectedId(null)
    setSelectedEdgeId(null)
    resetClipboard()
    setBindingNode(null)
    setProductionLogOpen(false)
    setProductionSettingsOpen(false)
  }, [activeSlug, loadLayout]) // eslint-disable-line react-hooks/exhaustive-deps

  const reloadServerRevision = () => doc.reloadServerRevision(() => {
    setSelectedId(null)
    setSelectedEdgeId(null)
    setBindingNode(null)
    setConflictOpen(false)
  })

  // The sheet's width against the window onto it. Shared by both modes so the
  // reading does not change meaning when an admin clicks Edit layout.
  const viewZoom = Math.round(((layout?.viewBox?.w || VIEW_W) / ui.viewport.w) * 100)

  // One element, placed once: in the full-screen banner when full screen, over
  // the sheet otherwise (MimicViewer decides). Never two copies in the tree.
  const viewToolbar = (
    <ViewToolbar
      fullscreen={fullscreen}
      onToggleFullscreen={toggleFullscreen}
      productionLogOpen={ui.productionLogOpen}
      onToggleLog={() => ui.setProductionLogOpen((shown) => !shown)}
      viewPan={ui.viewPan}
      onTogglePan={() => ui.setViewPan((on) => !on)}
      viewZoom={viewZoom}
      canvasRef={canvasRef}
    />
  )
  const headProps = {
    fullscreen, name: activeName, kpis, tags, status: data.plantStatus,
  }

  return (
    <div className={styles.page}>
      <OverviewPanel
        drawings={{
          layouts,
          activeSlug,
          activeName,
          canManage: canEdit,
          switchDisabled: editMode,
          onSelect: selectMimic,
        }}
        status={data.plantStatus}
        subtitle={data.subtitle}
        cadence={{
          intervalMs: data.liveMs,
          onInterval: data.setLiveMs,
          fastOpen: data.fastOpen,
          onFastOpen: data.setFastOpen,
        }}
        showEdit={canEdit && !!layout && !lock && !editMode}
        onEdit={lifecycle.startEditing}
        // Not in full screen: the banner carries its own copy, and two strips
        // in one tree would be two things to read before finding the drawing —
        // and two identically-labelled regions for a screen reader.
        kpiStrip={layout && !fullscreen && (
          <KpiStrip
            kpis={kpis}
            tags={tags}
            editing={editing}
            onEdit={ui.setEditingKpi}
            onAdd={actions.addKpi}
            onReorder={actions.commitKpis}
          />
        )}
      />

      {/* Read-only, and why. Sits above the data error because it describes
        * the drawing itself rather than this tick's poll. */}
      {lock && <Alert severity="warning">{lock}</Alert>}

      <ConnectionAlarmStrip sources={data.connSources} />

      {/* Named alarm tiles above already say which source and for how long;
        * the generic banner only earns its place when the strip has nothing
        * to say (e.g. a stale-but-answering source). */}
      {data.dataError && !data.anySourceFailed && <Alert severity="warning">{data.dataError}</Alert>}

      {/* Only the drawing waits on the switch — the switcher itself stays put,
        * so the control you just used does not vanish under your cursor. */}
      {!layout && <p className={styles.loading}>Loading the plant drawing…</p>}

      {layout && editing && (
        <MimicEditor
          layout={layout}
          tags={tags}
          customSymbols={data.customSymbols}
          datasources={data.datasources}
          doc={doc}
          chrome={chrome}
          selection={selection}
          edits={edits}
          lifecycle={lifecycle}
          stageRef={stageRef}
          canvasRef={canvasRef}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          head={<FullscreenHead {...headProps} />}
          viewZoom={viewZoom}
          setViewport={ui.setViewport}
          onOpenBinding={actions.openBinding}
          onAuthorSymbol={() => ui.setAuthoring(true)}
          onProductionSettings={() => ui.setProductionSettingsOpen(true)}
          onImport={() => ui.setImportOpen(true)}
          onExport={files.exportDraft}
        />
      )}

      {layout && !editing && (
        <MimicViewer
          layout={layout}
          tags={tags}
          history={data.history}
          events={data.events}
          activeName={activeName}
          activeSlug={activeSlug}
          canEdit={canEdit}
          intervalMs={data.liveMs}
          selection={selection}
          edits={edits}
          ui={ui}
          stageRef={stageRef}
          canvasRef={canvasRef}
          fullscreen={fullscreen}
          overlayHost={overlayHost}
          head={<FullscreenHead {...headProps} tools={viewToolbar} />}
          toolbar={viewToolbar}
        />
      )}

      {nodes.length > 0 && (
        <AttentionStrip
          attention={data.attention}
          selectedId={selection.selectedId}
          onSelect={selection.selectNode}
        />
      )}

      <MonitorDialogs
        ui={ui}
        actions={actions}
        lifecycle={lifecycle}
        files={files}
        overlayHost={overlayHost}
        layout={layout}
        snackbar={snackbar}
        onCloseSnackbar={closeSnackbar}
        notify={notify}
        onReloadServerRevision={reloadServerRevision}
      />
    </div>
  )
}
