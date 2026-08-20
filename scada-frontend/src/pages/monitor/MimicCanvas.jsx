import { useCallback, useMemo, useRef, useState } from 'react'
import {
  symbolDef, portPoint, bubbleSpec,
} from '@/components/mimic/symbols'
import InstrumentBubble from '@/components/mimic/InstrumentBubble'
import { isFlowing } from '@/components/mimic/tagStatus'
import { NORMAL_WIRE, WirePath, wireType } from '@/components/mimic/wireTypes'
import styles from './MimicCanvas.module.css'

export const VIEW_W = 1600
export const VIEW_H = 900
export const GRID = 8

/** How near a dropped wire must land to count as hitting a port. */
const PORT_SNAP = 26
/** InstrumentBubble's circle radius — kept in step so the handle covers it. */
const BUBBLE_R = 34
/** Below this a symbol stops being a drawing and becomes a smudge. */
const MIN_NODE = 24

/**
 * The eight resize grips, as fractions of the node box, with the edges each
 * one moves. Corners move two edges, so they also carry the aspect lock.
 */
const HANDLES = [
  { id: 'nw', fx: 0, fy: 0, ex: 'l', ey: 't', cursor: 'nwse-resize' },
  { id: 'n', fx: 0.5, fy: 0, ex: null, ey: 't', cursor: 'ns-resize' },
  { id: 'ne', fx: 1, fy: 0, ex: 'r', ey: 't', cursor: 'nesw-resize' },
  { id: 'e', fx: 1, fy: 0.5, ex: 'r', ey: null, cursor: 'ew-resize' },
  { id: 'se', fx: 1, fy: 1, ex: 'r', ey: 'b', cursor: 'nwse-resize' },
  { id: 's', fx: 0.5, fy: 1, ex: null, ey: 'b', cursor: 'ns-resize' },
  { id: 'sw', fx: 0, fy: 1, ex: 'l', ey: 'b', cursor: 'nesw-resize' },
  { id: 'w', fx: 0, fy: 0.5, ex: 'l', ey: null, cursor: 'ew-resize' },
]

const snap = (v) => Math.round(v / GRID) * GRID
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Ports anchored on a left/right edge route horizontally; top/bottom vertically. */
function portAxis(node, portName) {
  const frac = symbolDef(node)?.ports?.[portName]
  if (!frac) return 'h'
  return frac[0] === 0 || frac[0] === 1 ? 'h' : 'v'
}

/**
 * Orthogonal elbow between two ports. Recomputed from the endpoints' current
 * x/y on every render — edge geometry is never persisted, so dragging a node
 * cannot desynchronise the drawing from its pipes.
 */
function routeEdge(fromNode, fromPort, toNode, toPort) {
  const p0 = portPoint(fromNode, fromPort)
  const p1 = portPoint(toNode, toPort)
  const a0 = portAxis(fromNode, fromPort)
  const a1 = portAxis(toNode, toPort)

  if (a0 === 'h' && a1 === 'h') {
    if (Math.abs(p1.y - p0.y) < 1) return `M ${p0.x} ${p0.y} H ${p1.x}`
    const mx = (p0.x + p1.x) / 2
    return `M ${p0.x} ${p0.y} H ${mx} V ${p1.y} H ${p1.x}`
  }
  if (a0 === 'v' && a1 === 'v') {
    if (Math.abs(p1.x - p0.x) < 1) return `M ${p0.x} ${p0.y} V ${p1.y}`
    const my = (p0.y + p1.y) / 2
    return `M ${p0.x} ${p0.y} V ${my} H ${p1.x} V ${p1.y}`
  }
  if (a0 === 'h') return `M ${p0.x} ${p0.y} H ${p1.x} V ${p1.y}`
  return `M ${p0.x} ${p0.y} V ${p1.y} H ${p1.x}`
}

/**
 * The box a resize drag has arrived at.
 *
 * `drag` holds the box as it was when the grip was grabbed; deltas are
 * measured from there rather than accumulated, so a drag that wanders out to
 * the clamp and back comes home to the size it started from.
 *
 * The grip that moves snaps to the grid; the opposite edge does not move at
 * all. Resizing from the left is therefore "drag this edge to a grid line",
 * not "drag this edge and watch the other one drift".
 */
function resizeBox(drag, dx, dy, lockAspect) {
  const {
    x0, y0, w0, h0, handle,
  } = drag
  let { x, y, w, h } = { x: x0, y: y0, w: w0, h: h0 }

  if (handle.ex === 'l') {
    x = clamp(snap(x0 + dx), 0, x0 + w0 - MIN_NODE)
    w = x0 + w0 - x
  } else if (handle.ex === 'r') {
    w = clamp(snap(w0 + dx), MIN_NODE, VIEW_W - x0)
  }

  if (handle.ey === 't') {
    y = clamp(snap(y0 + dy), 0, y0 + h0 - MIN_NODE)
    h = y0 + h0 - y
  } else if (handle.ey === 'b') {
    h = clamp(snap(h0 + dy), MIN_NODE, VIEW_H - y0)
  }

  // Shift on a corner keeps the symbol's proportions. Width leads, because the
  // pointer has travelled further horizontally on almost every corner drag.
  if (lockAspect && handle.ex && handle.ey && w0 > 0) {
    h = clamp(Math.round((w * h0) / w0), MIN_NODE, VIEW_H)
    if (handle.ey === 't') y = clamp(y0 + h0 - h, 0, VIEW_H - h)
    else h = Math.min(h, VIEW_H - y0)
  }

  return { x, y, w, h }
}

/**
 * A node whose symbol type this bundle has no renderer for — a drawing saved by
 * a newer frontend, or one hand-edited in the database.
 *
 * It is drawn at the node's own box rather than skipped. `portPoint` falls back
 * to the box centre for a type it does not know, so every wire on this symbol
 * still lands on the placeholder instead of trailing off to the origin, and the
 * rest of the sheet keeps its geometry. It is inert: not selectable, not
 * draggable, with no ports to wire — there is nothing here to edit, and
 * MonitorPage has already locked the drawing read-only.
 */
function UnknownNode({ node }) {
  const { w, h } = node
  return (
    <g transform={`translate(${node.x} ${node.y})`} style={{ pointerEvents: 'none' }}>
      <rect className={styles.placeholder} x={0} y={0} width={w} height={h} rx={3} />
      <path className={styles.placeholderMark} d={`M 0 0 L ${w} ${h} M ${w} 0 L 0 ${h}`} />
      <text className={styles.placeholderLabel} x={w / 2} y={h / 2 + 4}>
        {node.type}
      </text>
      <text className={styles.placeholderLabel} x={w / 2} y={h + 16}>
        {node.label || node.tagId || ''}
      </text>
    </g>
  )
}

/**
 * MimicCanvas — the P&ID stage.
 *
 * Free-position SVG rather than react-grid-layout: a mimic needs arbitrary
 * {x,y} and edges between symbols, and RGL's vertical compaction would
 * reflow a pump under its tank on every drag.
 *
 * Coordinates are logical, never pixels. The viewBox is fixed at
 * 1600x900 and the element scales responsively, so pointer positions are
 * converted with `getScreenCTM().inverse()` — that handles both the scale
 * factor and the letterboxing introduced by preserveAspectRatio, which a raw
 * width ratio does not.
 *
 * Edit mode adds four direct-manipulation gestures, all going through the one
 * `dragRef`: drag a symbol to move it, drag a grip on its selection box to
 * resize it, drag from a port handle to run a new wire, drag a balloon to
 * reposition its readout.
 */
export default function MimicCanvas({
  layout,
  tags,
  selectedId,
  onSelect,
  selectedEdgeId = null,
  onSelectEdge,
  editMode = false,
  wirePen = NORMAL_WIRE,
  onMoveNode,
  onNudgeNode,
  onResizeNode,
  onDeleteNode,
  onAddEdge,
  onDeleteEdge,
  onMoveBubble,
  onOpenBinding,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const [draggingId, setDraggingId] = useState(null)
  // Which node is being resized, so the size readout only appears on the
  // symbol actually changing — a dimension shown on a symbol at rest is noise.
  const [resizingId, setResizingId] = useState(null)
  // The in-flight wire: start port, current cursor, and the port it would land
  // on if released now. Never committed until pointerup finds a target.
  const [wire, setWire] = useState(null)

  const penWire = wireType(wirePen)

  const nodeById = useCallback((id) => layout.nodes.find((n) => n.id === id), [layout.nodes])

  const toLogical = useCallback((evt) => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse())
    return { x: pt.x, y: pt.y }
  }, [])

  /**
   * Nearest port to a logical point, within PORT_SNAP.
   *
   * Hit-tested geometrically rather than off the DOM: the svg holds pointer
   * capture for the whole drag, so the port handles themselves never see the
   * pointerup that would land on them.
   */
  const findPort = useCallback((p, excludeNodeId) => {
    let best = null
    layout.nodes.forEach((n) => {
      if (n.id === excludeNodeId) return
      Object.keys(symbolDef(n)?.ports ?? {}).forEach((port) => {
        const pt = portPoint(n, port)
        const d = Math.hypot(pt.x - p.x, pt.y - p.y)
        if (d <= PORT_SNAP && (!best || d < best.d)) best = { node: n.id, port, d }
      })
    })
    return best
  }, [layout.nodes])

  /**
   * A drag calls preventDefault to keep the pointer capture clean, and that
   * also suppresses the browser's focus-on-press. Selecting anything therefore
   * has to hand focus to the stage itself, or arrow-key nudge and Delete would
   * only answer after someone happened to Tab here first. `.stage:focus-visible`
   * keeps the ring on the keyboard path, so a click still shows nothing.
   */
  const focusStage = useCallback(() => {
    svgRef.current?.focus({ preventScroll: true })
  }, [])

  const capture = useCallback((evt) => {
    evt.preventDefault()
    svgRef.current.setPointerCapture(evt.pointerId)
  }, [])

  const handleNodePointerDown = useCallback((evt, node) => {
    onSelect(node.id)
    if (!editMode) return
    const p = toLogical(evt)
    if (!p) return
    dragRef.current = {
      kind: 'node', id: node.id, ox: p.x - node.x, oy: p.y - node.y,
    }
    setDraggingId(node.id)
    capture(evt)
  }, [capture, editMode, onSelect, toLogical])

  const handleResizePointerDown = useCallback((evt, node, handle) => {
    // The grips sit on top of the symbol; without this the gesture would also
    // start a move drag on the node underneath.
    evt.stopPropagation()
    const p = toLogical(evt)
    if (!p) return
    dragRef.current = {
      kind: 'resize',
      id: node.id,
      handle,
      px: p.x,
      py: p.y,
      x0: node.x,
      y0: node.y,
      w0: node.w,
      h0: node.h,
      rot: node.rot || 0,
    }
    setResizingId(node.id)
    capture(evt)
  }, [capture, toLogical])

  const handlePortPointerDown = useCallback((evt, node, port) => {
    // Ports sit on top of the symbol; without this the gesture would also
    // start a move drag on the node underneath.
    evt.stopPropagation()
    const p = toLogical(evt)
    if (!p) return
    dragRef.current = { kind: 'wire', node: node.id, port }
    setWire({
      node: node.id, port, x: p.x, y: p.y, target: null,
    })
    capture(evt)
  }, [capture, toLogical])

  const handleBubblePointerDown = useCallback((evt, node, anchor, centre) => {
    evt.stopPropagation()
    onSelect(node.id)
    if (!editMode) return
    const p = toLogical(evt)
    if (!p) return
    dragRef.current = {
      kind: 'bubble',
      id: node.id,
      ax: anchor.x,
      ay: anchor.y,
      ox: p.x - centre.x,
      oy: p.y - centre.y,
    }
    capture(evt)
  }, [capture, editMode, onSelect, toLogical])

  const handlePointerMove = useCallback((evt) => {
    const drag = dragRef.current
    if (!drag) return
    const p = toLogical(evt)
    if (!p) return

    if (drag.kind === 'wire') {
      setWire({
        node: drag.node, port: drag.port, x: p.x, y: p.y, target: findPort(p, drag.node),
      })
      return
    }

    if (drag.kind === 'resize') {
      // The grips ride inside the node's own rotate transform, so the pointer
      // delta has to come back out of it before it can be read as "the left
      // edge moved this far". At rot 0 — which is every symbol until someone
      // turns one — this is the identity.
      const th = (-drag.rot * Math.PI) / 180
      const dxg = p.x - drag.px
      const dyg = p.y - drag.py
      const dx = dxg * Math.cos(th) - dyg * Math.sin(th)
      const dy = dxg * Math.sin(th) + dyg * Math.cos(th)
      onResizeNode(drag.id, resizeBox(drag, dx, dy, evt.shiftKey))
      return
    }

    if (drag.kind === 'bubble') {
      // Stored as an offset from the anchor, so the balloon keeps its relative
      // placement when the symbol itself is moved afterwards.
      onMoveBubble(drag.id, [
        Math.round(clamp(p.x - drag.ox, BUBBLE_R + 4, VIEW_W - BUBBLE_R - 4) - drag.ax),
        Math.round(clamp(p.y - drag.oy, BUBBLE_R + 16, VIEW_H - BUBBLE_R - 4) - drag.ay),
      ])
      return
    }

    const node = nodeById(drag.id)
    if (!node) return
    onMoveNode(drag.id, {
      x: clamp(snap(p.x - drag.ox), 0, VIEW_W - node.w),
      y: clamp(snap(p.y - drag.oy), 0, VIEW_H - node.h),
    })
  }, [findPort, nodeById, onMoveBubble, onMoveNode, onResizeNode, toLogical])

  const endDrag = useCallback((evt) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (drag.kind === 'wire') {
      if (wire?.target) onAddEdge({ node: drag.node, port: drag.port }, wire.target)
      setWire(null)
    } else {
      setDraggingId(null)
      setResizingId(null)
    }
    if (svgRef.current?.hasPointerCapture(evt.pointerId)) {
      svgRef.current.releasePointerCapture(evt.pointerId)
    }
  }, [onAddEdge, wire])

  const handleKeyDown = useCallback((evt) => {
    if (!editMode) return
    const del = evt.key === 'Delete' || evt.key === 'Backspace'

    if (selectedEdgeId) {
      if (!del) return
      evt.preventDefault()
      onDeleteEdge(selectedEdgeId)
      return
    }
    if (!selectedId) return

    if (del) {
      evt.preventDefault()
      onDeleteNode(selectedId)
      return
    }
    const step = evt.shiftKey ? 1 : GRID
    const delta = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }[evt.key]
    if (!delta) return
    evt.preventDefault()
    // A nudge is a delta, not a position: key auto-repeat can deliver several
    // keydowns before React re-renders, and an absolute position computed from
    // the rendered node would make every one of them overwrite the last.
    onNudgeNode(selectedId, delta[0], delta[1])
  }, [editMode, onDeleteEdge, onDeleteNode, onNudgeNode, selectedEdgeId, selectedId])

  const wireFromNode = wire ? nodeById(wire.node) : null
  const wireFrom = wireFromNode ? portPoint(wireFromNode, wire.port) : null
  const wireTo = wire?.target
    ? portPoint(nodeById(wire.target.node), wire.target.port)
    : wire

  // The legend lists what this drawing uses, not what the catalogue offers.
  // Nineteen rows against a three-line mimic is decoration; three is the key.
  const legend = useMemo(() => {
    const seen = []
    layout.edges.forEach((e) => {
      const id = e.service ?? NORMAL_WIRE
      if (!seen.includes(id)) seen.push(id)
    })
    return seen.map((id) => ({ id, ...wireType(id) }))
  }, [layout.edges])

  return (
    <svg
      ref={svgRef}
      className={`${styles.stage} ${editMode ? styles.stageEditing : ''}`}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={`${layout.name || 'Plant'} process mimic`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(e) => {
        focusStage()
        if (e.target === svgRef.current) onSelect(null)
      }}
    >
      <defs>
        <pattern id="mimic-grid" width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse">
          <path className={styles.grid} d={`M ${GRID * 5} 0 L 0 0 0 ${GRID * 5}`} fill="none" />
        </pattern>
      </defs>

      {editMode && <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="url(#mimic-grid)" />}

      {/* --- pipes: drawn first so equipment always sits on top ---------- */}
      <g>
        {layout.edges.map((edge) => {
          const from = nodeById(edge.from.node)
          const to = nodeById(edge.to.node)
          if (!from || !to) return null
          const d = routeEdge(from, edge.from.port, to, edge.to.port)
          // The snapshot is keyed by node id, so a pipe names the *drive* that
          // moves product through it, not a loop number — a tag id could belong
          // to two symbols, and dragging one would leave the other's line
          // marching to a pump that isn't there.
          const flowing = isFlowing(edge.flowNode ? tags[edge.flowNode] : null)
          return (
            <g key={edge.id}>
              {selectedEdgeId === edge.id && <path className={styles.edgeSelected} d={d} />}
              <WirePath
                d={d}
                wire={wireType(edge.service)}
                flowClass={`${styles.flow} ${flowing ? '' : styles.flowStopped}`}
                flowStopped={!flowing}
              />
              {/* A 2px line is not a click target. The fat invisible twin is,
                  and only while the drawing is being edited. */}
              {editMode && (
                <path
                  className={styles.edgeHit}
                  d={d}
                  onPointerDown={(e) => { e.stopPropagation(); focusStage(); onSelectEdge(edge.id) }}
                />
              )}
            </g>
          )
        })}
      </g>

      {/* --- equipment ---------------------------------------------------- */}
      <g>
        {layout.nodes.map((node) => {
          const def = symbolDef(node)
          // A symbol this bundle has no renderer for. Drawing nothing used to
          // leave a hole whose wires ran to empty space; drawing the box keeps
          // the sheet readable and says plainly what is missing.
          if (!def) return <UnknownNode key={node.id} node={node} />
          const { Component } = def
          // Keyed by node id, not loop id: two symbols may legitimately watch
          // the same loop, and each still needs its own reading and its own
          // pulse.
          const tag = tags[node.id] ?? null
          const selected = selectedId === node.id
          // A symbol that carries an instrument but has nothing bound to it is
          // an uncommissioned loop — drawn, but visibly not yet reading.
          const unbound = def.binding !== 'none' && !tag
          return (
            <g
              key={node.id}
              className={`${styles.node} ${editMode ? styles.nodeEditing : ''} ${draggingId === node.id ? styles.nodeDragging : ''} ${unbound ? styles.nodeUnbound : ''}`}
              transform={`translate(${node.x} ${node.y})${node.rot ? ` rotate(${node.rot} ${node.w / 2} ${node.h / 2})` : ''}`}
              onPointerDown={(e) => handleNodePointerDown(e, node)}
              // Double-click is the shortcut past the rail: "click the symbol
              // to choose its data source" should work straight off the
              // drawing, not only through the inspector.
              onDoubleClick={onOpenBinding ? (e) => { e.stopPropagation(); onOpenBinding(node) } : undefined}
              tabIndex={0}
              role="button"
              aria-label={`${def.label} ${node.label}${node.binding ? '' : ' — not connected'}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.id) } }}
            >
              <rect className={styles.hitbox} x={-6} y={-6} width={node.w + 12} height={node.h + 12} />
              <Component node={node} def={def} tag={tag} selected={selected} />
              {unbound && (
                <rect
                  className={styles.unboundOutline}
                  x={-8}
                  y={-8}
                  width={node.w + 16}
                  height={node.h + 16}
                  rx={4}
                />
              )}
              {selected && (
                <rect
                  className={styles.selection}
                  x={-10}
                  y={-10}
                  width={node.w + 20}
                  height={node.h + 20}
                  rx={4}
                />
              )}

              {/* Resize grips sit on the symbol's own box rather than on the
                  dashed selection halo: you are sizing the equipment, so the
                  edge you grab should be the edge that ends up there. They
                  live inside the node group so a rotated symbol keeps its
                  grips on its own corners. */}
              {selected && editMode && HANDLES.map((h) => (
                <rect
                  key={h.id}
                  className={styles.grip}
                  style={{ cursor: h.cursor }}
                  x={h.fx * node.w - 5}
                  y={h.fy * node.h - 5}
                  width={10}
                  height={10}
                  rx={1.5}
                  onPointerDown={(e) => handleResizePointerDown(e, node, h)}
                />
              ))}

              {resizingId === node.id && (
                <text className={styles.dimension} x={node.w / 2} y={-18}>
                  {Math.round(node.w)} × {Math.round(node.h)}
                </text>
              )}
            </g>
          )
        })}
      </g>

      {/* --- wiring handles: above equipment, so a port is always grabbable */}
      {editMode && (
        <g>
          {layout.nodes.map((node) => Object.keys(symbolDef(node)?.ports ?? {}).map((port) => {
            const p = portPoint(node, port)
            const origin = wire?.node === node.id && wire?.port === port
            const hot = wire?.target?.node === node.id && wire?.target?.port === port
            return (
              <g
                key={`${node.id}.${port}`}
                className={styles.port}
                onPointerDown={(e) => handlePortPointerDown(e, node, port)}
              >
                <circle className={styles.portHit} cx={p.x} cy={p.y} r={PORT_SNAP * 0.6} />
                <circle
                  className={`${styles.portDot} ${origin ? styles.portOrigin : ''} ${hot ? styles.portHot : ''}`}
                  cx={p.x}
                  cy={p.y}
                  r={hot || origin ? 7 : 5}
                />
              </g>
            )
          }))}
        </g>
      )}

      {/* The line being drawn, following the cursor until it finds a port.
        * It is drawn in the selected wire type from the first pixel — you are
        * pulling that actual cable, not a generic ghost that turns into one
        * after you let go. Until it has somewhere to land it stays faint and
        * carries a dashed lead, so it only reads as a real line once releasing
        * would make one. */}
      {wire && wireFrom && (
        <g className={styles.wire}>
          {wire.target
            ? (
              <WirePath
                d={`M ${wireFrom.x} ${wireFrom.y} L ${wireTo.x} ${wireTo.y}`}
                wire={penWire}
              />
            )
            : (
              <path
                className={styles.wireLead}
                d={`M ${wireFrom.x} ${wireFrom.y} L ${wireTo.x} ${wireTo.y}`}
                style={{ stroke: penWire.stroke }}
              />
            )}
        </g>
      )}

      {/* --- instrument balloons: last, so a pipe never crosses a reading -- */}
      <g>
        {layout.nodes.map((node) => {
          const spec = bubbleSpec(node)
          const tag = tags[node.id] ?? null
          // An unbound loop still gets its balloon (empty), so the drawing
          // reads as commissioned-in-progress rather than as a symbol that
          // never had an instrument.
          if (!spec || (!tag && !node.tagId)) return null
          const anchor = {
            x: node.x + spec.anchor[0] * node.w,
            y: node.y + spec.anchor[1] * node.h,
          }
          const centre = { x: anchor.x + spec.offset[0], y: anchor.y + spec.offset[1] }
          return (
            <g
              key={`b-${node.id}`}
              className={editMode ? styles.bubbleEditing : undefined}
              onPointerDown={editMode
                ? (e) => handleBubblePointerDown(e, node, anchor, centre)
                : undefined}
            >
              <InstrumentBubble
                tag={tag}
                tagId={node.tagId}
                anchorX={anchor.x}
                anchorY={anchor.y}
                cx={centre.x}
                cy={centre.y}
              />
              {editMode && (
                <circle
                  className={styles.bubbleHandle}
                  cx={centre.x}
                  cy={centre.y}
                  r={BUBBLE_R}
                />
              )}
            </g>
          )
        })}
      </g>

      {/* --- legend: style is the key, so show the styles.
        * Only the types this drawing actually uses — the catalogue is the
        * picker's job, and a key listing lines that are not on the sheet is
        * decoration rather than information. */}
      {legend.length > 0 && (
        <g transform={`translate(40 ${VIEW_H - 34})`}>
          {legend.map((entry, i) => (
            <g key={entry.id} transform={`translate(${i * 170} 0)`}>
              <WirePath d="M 0 0 H 34" wire={entry} />
              <text className={styles.legendText} x={44} y={4}>{entry.label}</text>
            </g>
          ))}
        </g>
      )}
    </svg>
  )
}
