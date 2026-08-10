import { useCallback, useRef, useState } from 'react'
import { SYMBOLS, portPoint } from '@/components/mimic/symbols'
import InstrumentBubble from '@/components/mimic/InstrumentBubble'
import { isFlowing } from '@/components/mimic/tagStatus'
import styles from './MimicCanvas.module.css'

export const VIEW_W = 1600
export const VIEW_H = 900
export const GRID = 8

const SERVICES = [
  { id: 'feedwater', label: 'Feedwater' },
  { id: 'steam', label: 'Steam' },
  { id: 'fuelgas', label: 'Fuel' },
  { id: 'fluegas', label: 'Flue gas' },
]

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
 */
export default function MimicCanvas({
  layout,
  tags,
  selectedId,
  onSelect,
  editMode = false,
  onMoveNode,
  onNudgeNode,
  onDeleteNode,
  onOpenBinding,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const [draggingId, setDraggingId] = useState(null)

  const nodeById = useCallback((id) => layout.nodes.find((n) => n.id === id), [layout.nodes])

  const toLogical = useCallback((evt) => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse())
    return { x: pt.x, y: pt.y }
  }, [])

  const handleNodePointerDown = useCallback((evt, node) => {
    onSelect(node.id)
    if (!editMode) return
    const p = toLogical(evt)
    if (!p) return
    evt.preventDefault()
    dragRef.current = { id: node.id, ox: p.x - node.x, oy: p.y - node.y }
    setDraggingId(node.id)
    svgRef.current.setPointerCapture(evt.pointerId)
  }, [editMode, onSelect, toLogical])

  const handlePointerMove = useCallback((evt) => {
    const drag = dragRef.current
    if (!drag) return
    const node = nodeById(drag.id)
    const p = toLogical(evt)
    if (!node || !p) return
    onMoveNode(drag.id, {
      x: clamp(snap(p.x - drag.ox), 0, VIEW_W - node.w),
      y: clamp(snap(p.y - drag.oy), 0, VIEW_H - node.h),
    })
  }, [nodeById, onMoveNode, toLogical])

  const endDrag = useCallback((evt) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDraggingId(null)
    if (svgRef.current?.hasPointerCapture(evt.pointerId)) {
      svgRef.current.releasePointerCapture(evt.pointerId)
    }
  }, [])

  const handleKeyDown = useCallback((evt) => {
    if (!editMode || !selectedId) return

    if (evt.key === 'Delete' || evt.key === 'Backspace') {
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
  }, [editMode, onDeleteNode, onNudgeNode, selectedId])

  return (
    <svg
      ref={svgRef}
      className={`${styles.stage} ${editMode ? styles.stageEditing : ''}`}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="Boiler house 1 process mimic"
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
              <path className={`${styles.line} ${styles[edge.service]}`} d={d} />
              {edge.service === 'steam' && <path className={styles.steamInner} d={d} />}
              <path
                className={`${styles.flow} ${flowTint || ''} ${flowing ? '' : styles.flowStopped}`}
                d={d}
              />
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

      {/* --- instrument balloons: last, so a pipe never crosses a reading -- */}
      <g>
        {layout.nodes.map((node) => {
          const def = SYMBOLS[node.type]
          const tag = tags[node.id] ?? null
          // An unbound loop still gets its balloon (empty), so the drawing
          // reads as commissioned-in-progress rather than as a symbol that
          // never had an instrument.
          if (!def?.bubble || (!tag && !node.tagId)) return null
          const ax = node.x + def.bubble.anchor[0] * node.w
          const ay = node.y + def.bubble.anchor[1] * node.h
          return (
            <InstrumentBubble
              key={`b-${node.id}`}
              tag={tag}
              tagId={node.tagId}
              anchorX={ax}
              anchorY={ay}
              cx={ax + def.bubble.offset[0]}
              cy={ay + def.bubble.offset[1]}
            />
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
