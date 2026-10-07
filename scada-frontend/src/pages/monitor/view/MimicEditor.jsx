import MimicCanvas, { SHEET_SIZES } from '../MimicCanvas'
import MimicCommandBar from '../MimicCommandBar'
import MimicEditorToolbar from '../MimicEditorToolbar'
import SymbolPalette from '../SymbolPalette'
import { sheetOf } from '../sheet'
import EditorInspector from './EditorInspector'
import styles from '../MonitorPage.module.css'

/**
 * Edit mode: palette on the left, the sheet and its drafting toolbar in the
 * middle, the inspector on the right. This whole workspace is what goes full
 * screen (`stageRef`), so the palette, canvas and inspector stay usable on a
 * wall display.
 *
 * Everything it needs arrives as the result objects of the page's hooks:
 * `chrome` (useEditorChrome), `selection` (useMimicSelection), `edits`
 * (useLayoutEdits), `doc` (useMimicDocument) and `lifecycle` (useEditLifecycle).
 */
export default function MimicEditor({
  layout, tags, customSymbols, datasources, doc, chrome, selection, edits, lifecycle,
  stageRef, canvasRef, fullscreen, onToggleFullscreen, head, viewZoom, setViewport,
  onOpenBinding, onAuthorSymbol, onProductionSettings, onImport, onExport,
}) {
  const { saving, editorSession, dirty } = doc
  const { selectedId, selectedEdgeId, groupIds, selectedNode, selectedEdge } = selection

  return (
    <div
      className={`${styles.editorWorkspace} ${saving ? styles.editorWorkspaceSaving : ''}`}
      aria-busy={saving}
      inert={saving ? true : undefined}
      ref={stageRef}
    >
      <aside className={`${styles.editorPaletteRail} ${chrome.paletteOpen ? '' : styles.editorRailClosed}`}>
        <button
          type="button"
          className={styles.editorRailToggle}
          aria-expanded={chrome.paletteOpen}
          onClick={chrome.togglePalette}
        >
          {chrome.paletteOpen ? 'Hide symbols' : 'Symbols'}
        </button>
        {chrome.paletteOpen && (
          <div className={styles.editorRailBody}>
            <SymbolPalette
              onAdd={edits.addSymbol}
              customSymbols={customSymbols}
              onAuthorSymbol={onAuthorSymbol}
            />
          </div>
        )}
      </aside>

      <main className={styles.editorCenter}>
        {/* No tools argument: edit mode has its own drafting toolbar
          * immediately below, which already carries these controls. */}
        {head}
        <MimicEditorToolbar
          toolMode={chrome.toolMode}
          onToolMode={chrome.setToolMode}
          wirePen={chrome.wirePen}
          onWirePen={chrome.setWirePen}
          gridVisible={chrome.gridVisible}
          onGridVisible={chrome.setGridVisible}
          snapEnabled={chrome.snapEnabled}
          onSnapEnabled={chrome.setSnapEnabled}
          zoomPercent={viewZoom}
          onZoomOut={() => canvasRef.current?.zoomOut()}
          onZoomIn={() => canvasRef.current?.zoomIn()}
          onResetView={() => canvasRef.current?.resetView()}
          onFit={() => canvasRef.current?.fitContents()}
          fullscreen={fullscreen}
          onFullscreen={onToggleFullscreen}
          onSnapshot={() => canvasRef.current?.snapshot()}
          onTogglePalette={chrome.togglePalette}
          onToggleInspector={chrome.toggleInspector}
          onProductionLog={onProductionSettings}
          productionLogConfigured={!!layout.productionLog}
          sheet={sheetOf(layout)}
          sheetSizes={SHEET_SIZES.map((size) => ({
            ...size,
            fits: layout.nodes.every((n) => n.x + n.w <= size.w && n.y + n.h <= size.h),
          }))}
          onSheetSize={edits.setSheetSize}
        />
        <div className={styles.editorCanvas}>
          <MimicCanvas
            ref={canvasRef}
            layout={layout}
            tags={tags}
            selectedId={selectedId}
            onSelect={selection.selectNode}
            groupIds={groupIds}
            onSelectMany={selection.selectMany}
            onMoveNodes={edits.moveNodes}
            onNudgeNodes={edits.nudgeNodes}
            onDeleteNodes={edits.deleteNodes}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={selection.selectEdge}
            editMode={!saving}
            wirePen={chrome.wirePen}
            toolMode={chrome.toolMode}
            gridVisible={chrome.gridVisible}
            snapEnabled={chrome.snapEnabled}
            onViewportChange={setViewport}
            onGestureStart={doc.beginGesture}
            onGestureEnd={doc.endGesture}
            onGestureCancel={doc.abortGesture}
            onMoveNode={edits.moveNode}
            onNudgeNode={edits.nudgeNode}
            onResizeNode={edits.resizeNode}
            onDeleteNode={edits.deleteNode}
            onAddEdge={edits.addEdge}
            onDeleteEdge={edits.deleteEdge}
            onMoveBubble={edits.moveBubble}
            onOpenBinding={onOpenBinding}
            onDropSymbol={({ type, symbolId }, point) => edits.addSymbol(type, symbolId, point)}
          />
        </div>
        <MimicCommandBar
          canUndo={editorSession.past.length > 0}
          canRedo={editorSession.future.length > 0}
          hasSelection={!!selectedNode || !!selectedEdge}
          canRotate={!!selectedNode}
          dirty={dirty}
          saving={saving}
          onUndo={doc.undoLayout}
          onRedo={doc.redoLayout}
          onRotate={edits.rotateSelection}
          onDelete={edits.deleteSelection}
          onReset={lifecycle.handleReset}
          onImport={onImport}
          onExport={onExport}
          onCancel={lifecycle.requestCancel}
          onSave={lifecycle.handleSave}
        />
      </main>

      <aside className={`${styles.editorInspectorRail} ${chrome.inspectorOpen ? '' : styles.editorRailClosed}`}>
        <button
          type="button"
          className={styles.editorRailToggle}
          aria-expanded={chrome.inspectorOpen}
          onClick={chrome.toggleInspector}
        >
          {chrome.inspectorOpen ? 'Hide inspector' : 'Inspector'}
        </button>
        {chrome.inspectorOpen && (
          <div className={styles.editorRailBody}>
            <EditorInspector
              layout={layout}
              datasources={datasources}
              selection={selection}
              edits={edits}
              onConnect={onOpenBinding}
            />
          </div>
        )}
      </aside>
    </div>
  )
}
