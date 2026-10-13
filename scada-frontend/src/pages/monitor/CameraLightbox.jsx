import {
  useCallback, useEffect, useRef, useState,
} from 'react'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import CloseIcon from '@mui/icons-material/Close'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import ZoomOutIcon from '@mui/icons-material/ZoomOut'
import FitScreenIcon from '@mui/icons-material/FitScreen'
import { OK_SLOT } from '@/api/cameras'
import useCameraFrameUrl from '@/components/mimic/useCameraFrameUrl'
import { clockTime } from './CameraRail'
import {
  MAX_SCALE, ZOOM_STEP, actualView, clampView, fitScale, fitView, isFitted, panBy, percentLabel,
  pinchMetrics, zoomAt,
} from './imageViewport'
import styles from './CameraLightbox.module.css'

// Same one-map-per-panel rule as CameraRail — see the note there.
const T = {
  dialogLabel: 'ดูภาพเต็ม',
  close: 'ปิด',
  zoomIn: 'ซูมเข้า',
  zoomOut: 'ซูมออก',
  zoomGroup: 'ซูมภาพ',
  fit: 'พอดีหน้าต่าง',
  actual: 'ขนาดจริง 100%',
  prev: 'ภาพก่อนหน้า',
  next: 'ภาพถัดไป',
  loading: 'กำลังโหลดภาพ…',
}

function bytesLabel(bytes) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

const TAP_MS = 300
const TAP_SLOP = 6

/**
 * CameraLightbox — the click-through view for one stored frame.
 *
 * The frame opens scaled to fit the stage so the whole thing is visible, then
 * the operator can zoom out/in with the header buttons, the mouse wheel,
 * +/- keys or a two-finger pinch, and pan by dragging (mouse or finger). Double
 * click / double tap toggles between fit and 100 %. The view maths live in
 * imageViewport.js; this component only feeds it pointer input. Resolution is
 * read off the image's load event and printed next to the timestamp — that is
 * the pixel size the vision system actually wrote, whatever the zoom.
 *
 * The strip only ever downloads small previews, so opening a frame fetches the
 * original on demand (ahead of any queued preview) and, once it lands, warms the
 * two neighbours so arrow-key paging is instant. Frames are addressed by their
 * durable id; the rail also stops refreshing its listing while this is open, so
 * `frames[index]` keeps meaning the frame the operator clicked.
 */
export default function CameraLightbox({
  cameraCode, slot, frames, index, label, container, onClose, onNavigate,
}) {
  const frame = frames[index]
  const [natural, setNatural] = useState(null)
  // The original, jumping the queue: this is the one image the operator asked for.
  const url = useCameraFrameUrl(cameraCode, slot, frame?.id, { priority: true })
  const total = frames.length
  // Warm the neighbours once this one has landed, never before — on a slow link
  // they would otherwise share bandwidth with the image being waited on.
  useCameraFrameUrl(cameraCode, slot, url ? frames[index + 1]?.id : null)
  useCameraFrameUrl(cameraCode, slot, url ? frames[index - 1]?.id : null)
  const imgRef = useRef(null)

  // Zoom / pan. `state.view` is { scale, x, y } (see imageViewport.js); `follow`
  // is true while the frame is still fit-to-stage, so a window resize re-fits it
  // instead of leaving a stale scale behind.
  const [stageEl, setStageEl] = useState(null)
  const [box, setBox] = useState(null)
  const [state, setState] = useState(null)
  const [dragging, setDragging] = useState(false)
  const geom = useRef({ natural: null, box: null })
  const pointers = useRef(new Map())
  const gesture = useRef({ x: 0, y: 0, moved: false })
  const lastTap = useRef({ t: 0, x: 0, y: 0 })

  function readNatural(img) {
    setNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }

  useEffect(() => {
    setNatural(null)
    setState(null)
    // A neighbour warmed by the prefetch is already a blob URL, so the browser
    // can finish loading this <img> in the same tick it mounts — before a React
    // onLoad listener can attach to catch it. Read `.complete` straight after
    // commit as the fallback for that case; onLoad below still covers a frame
    // that is genuinely still loading.
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth) readNatural(img)
  }, [url])

  // A poll can shrink the listing out from under an open frame; close rather
  // than render a caption for data that no longer exists.
  useEffect(() => {
    if (!frame) onClose()
  }, [frame, onClose])

  useEffect(() => { geom.current = { natural, box } })

  useEffect(() => {
    if (!stageEl) return undefined
    const measure = () => setBox({ w: stageEl.clientWidth, h: stageEl.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stageEl)
    return () => ro.disconnect()
  }, [stageEl])

  // First sight of a frame (or a new stage size): fit it, unless the operator
  // has already zoomed — then just keep their view inside the new bounds.
  useEffect(() => {
    if (!natural || !box) return
    setState((s) => (!s || s.follow
      ? { view: fitView(natural, box), follow: true }
      : { view: clampView(s.view, natural, box), follow: false }))
  }, [natural, box])

  const update = useCallback((fn) => {
    const { natural: n, box: b } = geom.current
    if (!n || !b) return
    setState((s) => {
      if (!s) return s
      const view = fn(s.view, n, b)
      return { view, follow: isFitted(view, n, b) }
    })
  }, [])

  const zoomBy = useCallback((factor) => {
    update((v, n, b) => zoomAt(v, n, b, v.scale * factor, b.w / 2, b.h / 2))
  }, [update])
  const toFit = useCallback(() => update((v, n, b) => fitView(n, b)), [update])
  const toActual = useCallback(() => update((v, n, b) => actualView(v, n, b)), [update])

  // Wheel needs a non-passive listener to stop the page scrolling underneath.
  useEffect(() => {
    if (!stageEl) return undefined
    function onWheel(e) {
      e.preventDefault()
      const r = stageEl.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))
      update((v, n, b) => zoomAt(v, n, b, v.scale * factor, e.clientX - r.left, e.clientY - r.top))
    }
    stageEl.addEventListener('wheel', onWheel, { passive: false })
    return () => stageEl.removeEventListener('wheel', onWheel)
  }, [stageEl, update])

  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1)
      else if (e.key === 'ArrowRight' && index < total - 1) onNavigate(index + 1)
      else if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP)
      else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP)
      else if (e.key === '0') toFit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, onNavigate, zoomBy, toFit])

  function localPoint(e) {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = localPoint(e)
    pointers.current.set(e.pointerId, pt)
    // A second finger turns the gesture into a pinch, which is never a tap.
    if (pointers.current.size === 1) gesture.current = { x: pt.x, y: pt.y, moved: false }
    else gesture.current.moved = true
    setDragging(true)
  }

  function onPointerMove(e) {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const pt = localPoint(e)
    pointers.current.set(e.pointerId, pt)
    const other = [...pointers.current].find(([id]) => id !== e.pointerId)
    if (!other) {
      if (Math.hypot(pt.x - gesture.current.x, pt.y - gesture.current.y) > TAP_SLOP) {
        gesture.current.moved = true
      }
      update((v, n, b) => panBy(v, n, b, pt.x - prev.x, pt.y - prev.y))
      return
    }
    const before = pinchMetrics(prev, other[1])
    const after = pinchMetrics(pt, other[1])
    gesture.current.moved = true
    if (before.dist <= 0) return
    update((v, n, b) => panBy(
      zoomAt(v, n, b, v.scale * (after.dist / before.dist), before.cx, before.cy),
      n, b, after.cx - before.cx, after.cy - before.cy,
    ))
  }

  function onPointerUp(e) {
    if (!pointers.current.delete(e.pointerId)) return
    if (pointers.current.size > 0) return
    setDragging(false)
    if (e.type === 'pointercancel' || gesture.current.moved) return
    // Tap. Two close together toggle fit <-> 100 % — done by hand because a touch
    // double-tap does not reliably fire dblclick once touch-action is off.
    const { x, y } = gesture.current
    const now = e.timeStamp
    const last = lastTap.current
    if (now - last.t < TAP_MS && Math.hypot(x - last.x, y - last.y) < TAP_SLOP * 4) {
      lastTap.current = { t: 0, x: 0, y: 0 }
      update((v, n, b) => (isFitted(v, n, b) ? zoomAt(v, n, b, 1, x, y) : fitView(n, b)))
    } else {
      lastTap.current = { t: now, x, y }
    }
  }

  if (!frame) return null

  const isOk = slot === OK_SLOT
  const size = bytesLabel(frame.size_bytes)
  const view = state?.view ?? null
  const minScale = fitScale(natural, box)
  const atMin = !view || view.scale <= minScale + 1e-6
  const atMax = !view || view.scale >= MAX_SCALE - 1e-6
  const canPan = !!view && (
    natural.w * view.scale > box.w + 0.5 || natural.h * view.scale > box.h + 0.5
  )
  // Hidden until the first fit lands, so a frame never flashes at full size.
  const imgStyle = view
    ? {
      width: natural.w,
      height: natural.h,
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    }
    : { visibility: 'hidden' }

  return (
    <Dialog
      open
      onClose={onClose}
      container={container}
      maxWidth={false}
      aria-label={`${label} — ${T.dialogLabel}`}
      slotProps={{ paper: { className: `${styles.paper} ${isOk ? styles.paperOk : ''}` } }}
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          <span className={styles.label}>{label}</span>
          <span className={styles.meta}>
            {clockTime(frame.captured_at)}
            {natural && ` · ${natural.w} × ${natural.h}px`}
            {size && ` · ${size}`}
          </span>
        </div>
        <div className={styles.tools} role="group" aria-label={T.zoomGroup}>
          <IconButton
            size="small"
            className={styles.toolBtn}
            aria-label={T.zoomOut}
            title={T.zoomOut}
            disabled={atMin}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <ZoomOutIcon fontSize="small" />
          </IconButton>
          <span className={styles.zoomPct} aria-live="polite">
            {view ? percentLabel(view.scale) : '—'}
          </span>
          <IconButton
            size="small"
            className={styles.toolBtn}
            aria-label={T.zoomIn}
            title={T.zoomIn}
            disabled={atMax}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <ZoomInIcon fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            className={styles.toolBtn}
            aria-label={T.fit}
            title={T.fit}
            disabled={!view || state.follow}
            onClick={toFit}
          >
            <FitScreenIcon fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            className={`${styles.toolBtn} ${styles.actualBtn}`}
            aria-label={T.actual}
            title={T.actual}
            disabled={!view || view.scale === 1}
            onClick={toActual}
          >
            1:1
          </IconButton>
        </div>
        <IconButton size="small" className={styles.closeBtn} aria-label={T.close} onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>

      <div className={styles.stage}>
        <IconButton
          className={styles.navBtn}
          disabled={index <= 0}
          aria-label={T.prev}
          onClick={() => onNavigate(index - 1)}
        >
          <ChevronLeftIcon />
        </IconButton>

        <div
          ref={setStageEl}
          className={[
            styles.viewport,
            canPan ? styles.pannable : '',
            canPan && dragging ? styles.panning : '',
          ].join(' ')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {url
            ? (
              <img
                ref={imgRef}
                src={url}
                alt=""
                className={styles.img}
                style={imgStyle}
                draggable={false}
                decoding="async"
                onLoad={(e) => readNatural(e.currentTarget)}
              />
            )
            : <span className={styles.loading}>{T.loading}</span>}
        </div>

        <IconButton
          className={styles.navBtn}
          disabled={index >= total - 1}
          aria-label={T.next}
          onClick={() => onNavigate(index + 1)}
        >
          <ChevronRightIcon />
        </IconButton>
      </div>

      <div className={styles.foot}>
        <span className={styles.count}>{`${index + 1} / ${total}`}</span>
      </div>
    </Dialog>
  )
}
