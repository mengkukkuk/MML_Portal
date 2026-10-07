import IconButton from '@mui/material/IconButton'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import { isCameraNode } from '@/components/mimic/symbols'
import MimicCanvas from '../MimicCanvas'
import TitleBlock from '../TitleBlock'
import DetailRail from '../DetailRail'
import CameraRail from '../CameraRail'
import ProductionLogDrawer from '../ProductionLogDrawer'
import styles from '../MonitorPage.module.css'

/**
 * View mode: the drawing with its floating controls, and the detail rail for
 * whatever symbol is selected. This sheet/rail grid (`.body`) is what goes full
 * screen (`stageRef`) while viewing.
 *
 * `head` is the full-screen banner and `toolbar` the view-control cluster. The
 * toolbar is placed here only when windowed; in full screen the caller has put
 * it inside the banner instead, so it exists exactly once.
 */
export default function MimicViewer({
  layout, tags, history, events, activeName, activeSlug, canEdit, intervalMs,
  selection, edits, ui, stageRef, canvasRef, fullscreen, overlayHost, head, toolbar,
}) {
  const {
    selectedId, selectedEdgeId, selectedNode, selectedTag,
  } = selection
  const {
    viewPan, setViewport, railCollapsed, setRailCollapsed, productionLogOpen, setProductionLogOpen,
  } = ui

  return (
    <div className={`${styles.body} ${productionLogOpen ? styles.bodyLogOpen : ''}`} ref={stageRef}>
      <div className={styles.stageWrap}>
        {head}
        <MimicCanvas
          ref={canvasRef}
          layout={layout}
          tags={tags}
          selectedId={selectedId}
          onSelect={selection.selectNode}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={selection.selectEdge}
          toolMode={viewPan ? 'pan' : 'select'}
          onViewportChange={setViewport}
          onMoveNode={edits.moveNode}
          onNudgeNode={edits.nudgeNode}
          onResizeNode={edits.resizeNode}
          onDeleteNode={edits.deleteNode}
          onAddEdge={edits.addEdge}
          onDeleteEdge={edits.deleteEdge}
          onMoveBubble={edits.moveBubble}
        />

        <TitleBlock
          layout={layout}
          name={activeName}
          // Re-rendered on every poll, so this is the time of the figures
          // on screen. Plant-local wall clock, like the rest of the page.
          asOf={new Date().toLocaleTimeString('en-GB', { hour12: false })}
        />

        {/* Windowed only. In full screen the same cluster is rendered
          * into the banner above instead, so it never covers the sheet. */}
        {!fullscreen && toolbar}

        <ProductionLogDrawer
          open={productionLogOpen}
          slug={activeSlug}
          configured={!!layout.productionLog}
          mode={layout.productionLog?.mode ?? null}
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
              ? <CameraRail node={selectedNode} tag={selectedTag} pollMs={intervalMs} container={overlayHost} />
              : <DetailRail tag={selectedTag} node={selectedNode} history={history[selectedId]} events={events} canBind={false} />
          )}
        </div>
      )}
    </div>
  )
}
