import { useCallback, useEffect, useRef } from 'react'
import { frameAt, pinchGeometry } from './trendZoom'

// A finger held this long without moving reads the chart instead of panning it.
const LONG_PRESS_MS = 400
// Movement under this is a finger resting, not a drag.
const SLOP_PX = 10
// Two taps this close in time and space are one double-tap.
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 30
// The rubber band: how far the chart gives past the window's edge, and how hard.
const NUDGE_MAX_PX = 28
const NUDGE_RATIO = 0.3

const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel']
const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']

/**
 * Finger control for the signal trend — the touch half of useTrendViewport.
 *
 *   one finger, sideways   pan along time (the time under the finger stays under it)
 *   one finger, up/down    the page scrolls — the stage is `touch-action: pan-y`,
 *                          so the browser takes it and cancels the gesture here
 *   two fingers            pinch zoom around their midpoint, panning as it moves
 *   tap                    the tooltip at that point; outside the plot hides it
 *   hold, then slide       scrub: the tooltip follows the finger until it lifts
 *   double-tap             the whole window again
 *
 * Touch is taken whole, on native capture listeners at the stage, rather than
 * shared with ECharts. Its own `inside` zoom would pinch at the same time as this
 * does, and the React handlers on the stage (the mouse zoom box) would start a
 * marquee under every finger. Stopping touch at the stage keeps both away from
 * it; mouse and pen events pass through untouched, so a touch laptop still draws
 * the box with its trackpad and pans with a finger, event by event.
 *
 * Every frame is worked out from where the gesture *started* (see frameAt), so a
 * long drag cannot drift.
 *
 * `opts` (read through a ref, so it may be a new object every render):
 *   chart()        the live ECharts instance, or null
 *   plotRect()     the grid's rect in chart pixels, or null
 *   full()         the window, { from, to } in ms
 *   view()         the view on screen, or null for the whole window
 *   onView(view)   move the chart to a view (null = the whole window)
 *   onReset()      double-tap
 *   onHold(on)     a finger went down on / the last one left the chart
 *
 * Returns a callback ref for the stage element.
 */
export default function useTouchGestures(opts) {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const cleanupRef = useRef(null)

  const attach = useCallback((stage) => {
    const o = () => optsRef.current
    const pointers = new Map()
    let g = null          // the gesture in progress
    let timer = null
    let frame = null
    let pendingView
    let lastTap = null
    let holding = false

    const local = (e, bounds) => ({ x: e.clientX - bounds.left, y: e.clientY - bounds.top })
    const timeAt = (chart, x, rect) => chart.convertFromPixel('grid', [x, rect.y])?.[0]
    const currentSpan = () => {
      const view = o().view()
      const full = o().full()
      return view ? view.to - view.from : full.to - full.from
    }

    const setHolding = (on) => {
      if (holding === on) return
      holding = on
      o().onHold?.(on)
    }

    // Views are applied once per frame: a finger reports far more often than the
    // screen redraws, and each dispatch re-renders the chart.
    const applyView = (view) => {
      pendingView = view
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        o().onView(pendingView)
      })
    }

    const nudge = (px) => {
      const canvas = stage.firstElementChild
      if (!canvas) return
      canvas.style.transition = px ? 'none' : 'transform 0.25s ease-out'
      canvas.style.transform = px ? `translateX(${px.toFixed(1)}px)` : ''
    }

    const showTip = (chart, p, rect) => {
      const x = Math.max(rect.x, Math.min(p.x, rect.x + rect.width))
      chart.dispatchAction({ type: 'showTip', x, y: Math.max(rect.y, Math.min(p.y, rect.y + rect.height)) })
    }

    const clearTimer = () => {
      if (timer != null) clearTimeout(timer)
      timer = null
    }

    // A one-finger pan from wherever that finger is now.
    const startPan = (chart, p, bounds, rect) => {
      const anchor = timeAt(chart, p.x, rect)
      if (!Number.isFinite(anchor)) return null
      return { mode: 'pan', bounds, rect, anchor, span: currentSpan() }
    }

    const startPinch = (chart, bounds, rect) => {
      const [a, b] = [...pointers.values()]
      const { dist, mid } = pinchGeometry(a, b)
      const anchor = timeAt(chart, mid.x, rect)
      if (!Number.isFinite(anchor) || dist < 1) return null
      return { mode: 'pinch', bounds, rect, anchor, span: currentSpan(), dist }
    }

    const onPointerDown = (e) => {
      if (e.pointerType !== 'touch') return
      e.stopPropagation()
      const chart = o().chart()
      const rect = chart && !chart.isDisposed() ? o().plotRect() : null
      if (!rect) return
      const bounds = stage.getBoundingClientRect()
      const p = local(e, bounds)
      pointers.set(e.pointerId, p)
      setHolding(true)

      if (pointers.size === 1) {
        clearTimer()
        g = { mode: 'pending', bounds, rect, start: p, at: e.timeStamp }
        timer = setTimeout(() => {
          timer = null
          if (g?.mode !== 'pending') return
          g = { ...g, mode: 'scrub' }
          showTip(chart, pointers.values().next().value ?? p, rect)
        }, LONG_PRESS_MS)
      } else if (pointers.size === 2) {
        clearTimer()
        nudge(0)
        g = startPinch(chart, bounds, rect)
      }
    }

    const onPointerMove = (e) => {
      if (e.pointerType !== 'touch' || !pointers.has(e.pointerId)) return
      e.stopPropagation()
      const chart = o().chart()
      if (!g || !chart || chart.isDisposed()) return
      const p = local(e, g.bounds)
      pointers.set(e.pointerId, p)
      const full = o().full()

      if (g.mode === 'pending') {
        const dx = p.x - g.start.x
        const dy = p.y - g.start.y
        if (Math.hypot(dx, dy) < SLOP_PX) return
        clearTimer()
        // Mostly vertical is the page's; the browser will cancel this shortly.
        if (Math.abs(dx) < Math.abs(dy)) { g = { ...g, mode: 'ignored' }; return }
        g = startPan(chart, g.start, g.bounds, g.rect)
        if (!g) return
      }

      if (g.mode === 'pan') {
        const frac = (p.x - g.rect.x) / g.rect.width
        const { view, overshoot } = frameAt(full, g.anchor, frac, g.span)
        applyView(view)
        const px = (overshoot / g.span) * g.rect.width
        nudge(Math.max(-NUDGE_MAX_PX, Math.min(NUDGE_MAX_PX, -px * NUDGE_RATIO)))
      } else if (g.mode === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        const { dist, mid } = pinchGeometry(a, b)
        if (dist < 1) return
        const frac = (mid.x - g.rect.x) / g.rect.width
        applyView(frameAt(full, g.anchor, frac, g.span * (g.dist / dist)).view)
      } else if (g.mode === 'scrub') {
        showTip(chart, p, g.rect)
      }
    }

    const onPointerEnd = (e) => {
      if (e.pointerType !== 'touch' || !pointers.has(e.pointerId)) return
      e.stopPropagation()
      const p = pointers.get(e.pointerId)
      pointers.delete(e.pointerId)
      const chart = o().chart()
      const live = chart && !chart.isDisposed()

      if (g?.mode === 'pending' && e.type === 'pointerup' && live) {
        clearTimer()
        const double = lastTap
          && e.timeStamp - lastTap.at < DOUBLE_TAP_MS
          && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_PX
        if (double) {
          lastTap = null
          chart.dispatchAction({ type: 'hideTip' })
          o().onReset?.()
        } else {
          lastTap = { at: e.timeStamp, x: p.x, y: p.y }
          if (chart.containPixel('grid', [p.x, p.y])) showTip(chart, p, g.rect)
          else chart.dispatchAction({ type: 'hideTip' })
        }
      }

      // Lifting one finger of a pinch carries on as a pan with the other.
      if (g?.mode === 'pinch' && pointers.size === 1 && live) {
        g = startPan(chart, pointers.values().next().value, g.bounds, g.rect)
        return
      }

      if (pointers.size === 0) {
        clearTimer()
        g = null
        nudge(0)
        setHolding(false)
      }
    }

    // Scrolling is decided on touchmove, so this is where a pan, a pinch or a
    // scrub keeps the page still. Non-passive, or the browser ignores it.
    const onTouch = (e) => {
      e.stopPropagation()
      if (e.type === 'touchmove' && e.cancelable && g && g.mode !== 'pending' && g.mode !== 'ignored') {
        e.preventDefault()
      }
    }

    // A long press would otherwise open the browser's context menu mid-scrub.
    const onContextMenu = (e) => {
      if (g) e.preventDefault()
    }

    const handlers = {
      pointerdown: onPointerDown,
      pointermove: onPointerMove,
      pointerup: onPointerEnd,
      pointercancel: onPointerEnd,
    }
    POINTER_EVENTS.forEach((type) => stage.addEventListener(type, handlers[type], true))
    TOUCH_EVENTS.forEach((type) => stage.addEventListener(type, onTouch, { capture: true, passive: false }))
    stage.addEventListener('contextmenu', onContextMenu, true)

    return () => {
      POINTER_EVENTS.forEach((type) => stage.removeEventListener(type, handlers[type], true))
      TOUCH_EVENTS.forEach((type) => stage.removeEventListener(type, onTouch, { capture: true }))
      stage.removeEventListener('contextmenu', onContextMenu, true)
      clearTimer()
      if (frame != null) cancelAnimationFrame(frame)
      nudge(0)
      setHolding(false)
    }
  }, [])

  // A callback ref: the stage mounts and unmounts with the chart (an empty
  // window has none), and its listeners have to follow it.
  const ref = useCallback((stage) => {
    cleanupRef.current?.()
    cleanupRef.current = stage ? attach(stage) : null
  }, [attach])

  useEffect(() => () => cleanupRef.current?.(), [])

  return ref
}
