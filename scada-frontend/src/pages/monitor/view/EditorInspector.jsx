import GroupInspector from '../GroupInspector'
import NodeInspector from '../NodeInspector'
import EdgeInspector from '../EdgeInspector'
import styles from '../MonitorPage.module.css'

/**
 * The editor's right-hand inspector: one panel for whatever is selected — a
 * wire, a group of symbols, a single symbol — or a hint when nothing is.
 * `selection` is `useMimicSelection`'s result and `edits` is `useLayoutEdits`'s.
 */
export default function EditorInspector({
  layout, datasources, selection, edits, onConnect,
}) {
  const {
    selectedEdge, selectedNode, groupIds, setGroupIds, setSelectedId, setSelectedEdgeId,
  } = selection

  if (selectedEdge) {
    return (
      <EdgeInspector
        edge={selectedEdge}
        nodes={layout.nodes}
        onChange={(patch) => edits.updateEdge(selectedEdge.id, patch)}
        onDelete={edits.deleteEdge}
        onBack={() => setSelectedEdgeId(null)}
      />
    )
  }
  if (groupIds.length > 1) {
    return (
      <GroupInspector
        nodes={layout.nodes.filter((n) => groupIds.includes(n.id))}
        onOptions={(patch) => edits.setNodesOptions(groupIds, patch)}
        onDelete={() => edits.deleteNodes(groupIds)}
        onBack={() => setGroupIds([])}
      />
    )
  }
  if (selectedNode) {
    return (
      <NodeInspector
        node={selectedNode}
        datasources={datasources}
        onConnect={() => onConnect(selectedNode)}
        onDelete={edits.deleteNode}
        onResetBubble={edits.resetBubble}
        onResetSize={edits.resetNodeSize}
        onRotate={edits.rotateNode}
        onOptions={edits.setNodeOptions}
        theme={layout?.theme}
        onTheme={edits.setLayoutTheme}
        onBack={() => setSelectedId(null)}
      />
    )
  }
  return (
    <div className={styles.editorHelp}>
      <span>Inspector</span>
      <h3>Select a symbol or wire</h3>
      <p>Properties, datasource bindings, rotation, size, and flow rules appear here. Drag from a symbol port to create a connection.</p>
      <kbd>Space + drag</kbd><small>Pan canvas</small>
      <kbd>Ctrl/Cmd + wheel</kbd><small>Zoom at pointer</small>
    </div>
  )
}
