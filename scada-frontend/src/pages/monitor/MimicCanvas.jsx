import { useCallback, useRef, useState } from 'react'
import {
  SYMBOLS, portPoint, bubbleSpec,
} from '@/components/mimic/symbols'
import InstrumentBubble from '@/components/mimic/InstrumentBubble'
import { isFlowing } from '@/components/mimic/tagStatus'
import styles from './MimicCanvas.module.css'

export const VIEW_W = 1600
export const VIEW_H = 900
export const GRID = 8

export const SERVICES = [
  { id: 'feedwater', label: 'Feedwater' },
  { id: 'steam', label: 'Steam' },
  { id: 'fuelgas', label: 'Fuel' },
  { id: 'fluegas', label: 'Flue gas' },
]

/** How near a dropped wire must land to count as hitting a port. */
const PORT_SNAP = 26
/** InstrumentBubble's circle radius — kept in step so the handle covers it. */
const BUBBLE_R = 34

const snap = (v) => Math.round(v / GRID) * GRID
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Ports anchored on a left/right edge route horizontally; top/bottom vertically. */
function portAxis(node, portName) {
  const frac = SYMBOLS[node.type]?.ports?.[portName]
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
 * Edit mode adds three direct-manipulation gestures, all going through the one
 * `dragRef`: drag a symbol to move it, drag from a port handle to run a new
 * pipe, drag a balloon to reposition its readout.
 */
export default function MimicCanvas({
  layout,
  tags,
  selectedId,
  onSelect,
  selectedEdgeId = null,
  onSelectEdge,
  editMode = false,
  onMoveNode,
  onNudgeNode,
  onDeleteNode,
  onAddEdge,
  onDeleteEdge,
  onMoveBubble,
  onOpenBinding,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const [draggingId, setDraggingId] = useState(null)
  // The in-flight wire: start port, current cursor, and the port it would land
  // on if released now. Never committed until pointerup finds a target.
  const [wire, setWire] = useState(null)

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
      Object.keys(SYMBOLS[n.type]?.ports ?? {}).forEach((port) => {
        const pt = portPoint(n, port)
        const d = Math.hypot(pt.x - p.x, pt.y - p.y)
        if (d <= PORT_SNAP && (!best || d < best.d)) best = { node: n.id, port, d }
      })
    })
    return best
  }, [layout.nodes])

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
  }, [findPort, nodeById, onMoveBubble, onMoveNode, toLogical])

  const endDrag = useCallback((evt) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (drag.kind === 'wire') {
      if (wire?.target) onAddEdge({ node: drag.node, port: drag.port }, wire.target)
      setWire(null)
    } else {
      setDraggingId(null)
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
      onPointerDown={(e) => { if (e.target === svgRef.current) onSelect(null) }}
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
          const flowTint = {
            steam: styles.flowSteam, fuelgas: styles.flowFuelgas, fluegas: styles.flowFluegas,
          }[edge.service]
          return (
            <g key={edge.id}>
              {selectedEdgeId === edge.id && <path className={styles.edgeSelected} d={d} />}
              <path className={`${styles.line} ${styles[edge.service]}`} d={d} />
              {edge.service === 'steam' && <path className={styles.steamInner} d={d} />}
              <path
                className={`${styles.flow} ${flowTint || ''} ${flowing ? '' : styles.flowStopped}`}
                d={d}
              />
              {/* A 2px line is not a click target. The fat invisible twin is,
                  and only while the drawing is being edited. */}
              {editMode && (
                <path
                  className={styles.edgeHit}
                  d={d}
                  onPointerDown={(e) => { e.stopPropagation(); onSelectEdge(edge.id) }}
                />
              )}
            </g>
          )
        })}
      </g>

      {/* --- equipment ---------------------------------------------------- */}
      <g>
        {layout.nodes.map((node) => {
          const def = SYMBOLS[node.type]
          if (!def) return null
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
              <Component node={node} tag={tag} selected={selected} />
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
            </g>
          )
        })}
      </g>

      {/* --- wiring handles: above equipment, so a port is always grabbable */}
      {editMode && (
        <g>
          {layout.nodes.map((node) => Object.keys(SYMBOLS[node.type]?.ports ?? {}).map((port) => {
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

      {/* the pipe being drawn, following the cursor until it finds a port */}
      {wire && wireFrom && (
        <path
          className={`${styles.wire} ${wire.target ? styles.wireLocked : ''}`}
          d={`M ${wireFrom.x} ${wireFrom.y} L ${wireTo.x} ${wireTo.y}`}
        />
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

      {/* --- service legend: style is the key, so show the styles ---------- */}
      <g transform={`translate(40 ${VIEW_H - 34})`}>
        {SERVICES.map((svc, i) => (
          <g key={svc.id} transform={`translate(${i * 160} 0)`}>
            <path className={`${styles.line} ${styles[svc.id]}`} d="M 0 0 H 34" />
            <text className={styles.legendText} x={44} y={4}>{svc.label}</text>
          </g>
        ))}
      </g>
    </svg>
  )
}
