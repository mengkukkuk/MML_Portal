import IconButton from '@mui/material/IconButton'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import { isCameraNode } from '@/components/mimic/symbols'
import MimicCanvas from '../MimicCanvas'
import DetailRail from '../DetailRail'
import CameraRail from '../CameraRail'
import ProductionLogDrawer from '../ProductionLogDrawer'
import styles from '../MonitorPage.module.css'

/**
 * View mode: the drawing, and the detail rail for whatever symbol is selected.
 * This sheet/rail grid (`.body`) is what goes full screen (`stageRef`) while
 * viewing.
 *
 * Nothing sits over the sheet. `head` is the full-screen banner, and the view
 * controls live in it (full screen) or in the overview bar above (windowed) —
 * the caller places them. The drawing's name and the poll time are already in
 * that bar, so the sheet carries no title block of its own.
 */
export default function MimicViewer({
  layout, tags, history, events, activeSlug, canEdit, intervalMs,
  selection, edits, ui, stageRef, canvasRef, overlayHost, head,
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
