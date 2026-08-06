import { useCallback, useMemo, useState } from 'react'
import Button from '@mui/material/Button'
import BoltOutlined from '@mui/icons-material/BoltOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import { useAuthStore } from '@/stores/auth'
import useMockPlant from '@/components/mimic/useMockPlant'
import { SYMBOLS } from '@/components/mimic/symbols'
import { TAG_IDS, formatValue, worseStatus } from '@/components/mimic/mockPlant'
import MimicCanvas, { VIEW_W, VIEW_H } from './MimicCanvas'
import DetailRail from './DetailRail'
import SymbolPalette from './SymbolPalette'
import { loadLayout, saveLayout, resetLayout } from './layoutStorage'
import styles from './MonitorPage.module.css'

const CADENCES = [
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
]

/** The tag "Simulate excursion" pushes over its high-high limit. */
const EXCURSION_TAG = 'TT-202'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

let addCounter = 0

/**
 * MonitorPage — single-asset mimic for Boiler House 1 (route: /monitor).
 *
 * /live answers "how are all my things doing?". This answers "what is this
 * plant doing right now, and why?" — one P&ID-style drawing where the live
 * values sit inside ISA instrument balloons, symbols animate from their own
 * state, and selecting an asset opens its full context in the rail.
 *
 * There is no backend here: values come from the local simulator in
 * components/mimic/mockPlant.js and the layout persists to localStorage.
 */
export default function MonitorPage() {
  const role = useAuthStore((s) => s.user?.role ?? null)
  const canEdit = role === 'admin'

  const [tickMs, setTickMs] = useState(1000)
  const {
    tags, history, events, simulateExcursion, excursionTag,
  } = useMockPlant({ tickMs })

  const [layout, setLayout] = useState(loadLayout)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedTagId, setSelectedTagId] = useState(null)
  const [editMode, setEditMode] = useState(false)

  const selectedNode = layout.nodes.find((n) => n.id === selectedId) ?? null
  const activeTagId = selectedNode?.tag ?? selectedTagId
  const activeTag = activeTagId ? tags[activeTagId] : null

  const plantStatus = useMemo(
    () => Object.values(tags).reduce((acc, t) => worseStatus(acc, t.status), 'normal'),
    [tags],
  )

  const selectNode = useCallback((id) => {
    setSelectedId(id)
    setSelectedTagId(null)
  }, [])

  const selectTag = useCallback((tagId) => {
    const owner = layout.nodes.find((n) => n.tag === tagId)
    setSelectedId(owner?.id ?? null)
    setSelectedTagId(owner ? null : tagId)
  }, [layout.nodes])

  const moveNode = useCallback((id, pos) => {
    setLayout((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...pos } : n)),
    }))
  }, [])

  // Keyboard nudge. Resolved against the node in `prev` rather than the
  // rendered one so a burst of key repeats accumulates instead of collapsing
  // to whichever keydown happened to land last.
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
    const id = `n-new-${addCounter}`
    const node = {
      id,
      type,
      tag: null,
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

  const toggleEdit = useCallback(() => {
    setEditMode((on) => {
      if (on) saveLayout(layout)
      return !on
    })
  }, [layout])

  const handleReset = useCallback(() => {
    setLayout(resetLayout())
    setSelectedId(null)
  }, [])

  const dotClass = plantStatus === 'crit' ? styles.dotCrit
    : plantStatus === 'warn' ? styles.dotWarn : ''

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={styles.titleWrap}>
          <h2 className={styles.title}>Boiler House 1</h2>
          <p className={styles.sub}>Steam skid · simulated process · no datasource</p>
        </div>

        <span className={styles.plantState}>
          <span className={`${styles.dot} ${dotClass}`} />
          {plantStatus === 'crit' ? 'Alarm' : plantStatus === 'warn' ? 'Off normal' : 'Running'}
        </span>

        <div className={styles.actions}>
          <div className={styles.cadence} role="group" aria-label="Update interval">
            {CADENCES.map((c) => (
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

          <Button
            startIcon={<BoltOutlined />}
            color={excursionTag ? 'warning' : 'inherit'}
            onClick={() => simulateExcursion(EXCURSION_TAG)}
            title={`Drive ${EXCURSION_TAG} past its high-high limit for 15 seconds`}
          >
            Simulate excursion
          </Button>

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
                onClick={toggleEdit}
              >
                {editMode ? 'Done' : 'Edit layout'}
              </Button>
            </>
          )}
        </div>
      </header>

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
        />

        {editMode && canEdit
          ? <SymbolPalette onAdd={addSymbol} />
          : (
            <DetailRail
              tag={activeTag}
              node={selectedNode}
              history={activeTagId ? history[activeTagId] : null}
              events={events}
            />
          )}
      </div>

      <div className={styles.strip} role="group" aria-label="All plant tags">
        {TAG_IDS.map((id) => {
          const tag = tags[id]
          if (!tag) return null
          const on = activeTagId === id
          const tone = tag.status === 'crit' ? styles.chipCrit
            : tag.status === 'warn' ? styles.chipWarn : ''
          return (
            <button
              key={id}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''} ${tone}`}
              aria-pressed={on}
              onClick={() => selectTag(id)}
            >
              <span className={styles.chipId}>{id}</span>
              <span className={styles.chipValue}>{formatValue(tag)}</span>
              {tag.unit && <span className={styles.chipUnit}>{tag.unit}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
