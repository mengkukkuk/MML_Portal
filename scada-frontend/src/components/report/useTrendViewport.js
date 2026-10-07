import { useCallback, useReducer, useRef, useState } from 'react'
import {
  ZOOM_STEP, canZoomIn, canZoomOut, resolveView, selectionToView, viewFromRange, zoomBy,
  zoomPercent,
} from './trendZoom'

/** A pointer drag shorter than this is a click, not a zoom box. */
const MIN_BOX_PX = 6

/**
 * The signal trend's view controls: zoom in / out, fit, the hand tool and the
 * drag-a-box zoom — driving one ECharts instance, with the arithmetic in
 * trendZoom.js.
 *
 * Two modes share the chart, switched by `hand`:
 *   off  dragging draws a box and zooms to it (the wheel and the buttons zoom too)
 *   on   dragging pans — ECharts' own `inside` zoom, enabled for the occasion
 *
 * The view lives in a **ref**, not state, on purpose. It changes on every wheel
 * notch and every pixel of a pan, and the chart's `option` is rebuilt from it
 * whenever data arrives; if the view were state, each gesture would re-render the
 * page and re-apply the option mid-drag, which tears the drag down. The ref is
 * what the option builder reads (`currentView`), a counter re-renders only the
 * controls that show it (the zoom readout), and the chart itself is moved with
 * `dispatchAction` so ECharts keeps the gesture.
 *
 * `full` is the window the data was read for and slides on a live refresh. The
 * view is absolute time (see trendZoom.js), so a refresh keeps what you zoomed
 * into where it was — or, for a view pinned to the newest edge, moves with it.
 * `resetKey` names the binding (source, table, readings, window); a new one
 * starts again from the whole window.
 */
export default function useTrendViewport({ full, resetKey }) {
  const chartRef = useRef(null)
  const viewRef = useRef(null)
  const fullRef = useRef(full)
  fullRef.current = full
  const keyRef = useRef(resetKey)
  // A different signal is a different picture; carrying the old zoom over would
  // frame it with numbers that belonged to something else. Reset during render
  // (idempotent) so the option built next already sees it.
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey
    viewRef.current = null
  }

  const [, repaint] = useReducer((n) => n + 1, 0)
  const [hand, setHand] = useState(false)
  const [box, setBox] = useState(null)
  const dragRef = useRef(null)

  const currentView = useCallback(() => resolveView(viewRef.current, fullRef.current), [])

  // Move the chart to `view` (null = everything). The `datazoom` event that
  // follows is what normally records it; recording it here too keeps the controls
  // right when the chart is not there to answer (a hidden tab, a disposed chart).
  const show = useCallback((view) => {
    viewRef.current = view
    const chart = chartRef.current
    if (chart && !chart.isDisposed()) {
      chart.dispatchAction(view
        ? { type: 'dataZoom', startValue: view.from, endValue: view.to }
        : { type: 'dataZoom', start: 0, end: 100 })
    }
    repaint()
  }, [])

  const onReady = useCallback((chart) => {
    chartRef.current = chart
    if (!chart) return
    chart.on('datazoom', () => {
      const zoom = chart.getOption()?.dataZoom?.[0]
      if (!zoom || !Number.isFinite(zoom.startValue) || !Number.isFinite(zoom.endValue)) return
      viewRef.current = viewFromRange({ from: zoom.startValue, to: zoom.endValue }, fullRef.current)
      repaint()
    })
  }, [])

  const zoomIn = useCallback(() => show(zoomBy(viewRef.current, fullRef.current, ZOOM_STEP)), [show])
  const zoomOut = useCallback(() => show(zoomBy(viewRef.current, fullRef.current, 1 / ZOOM_STEP)), [show])
  const reset = useCallback(() => show(null), [show])

  // --- the zoom box -----------------------------------------------------------
  const plotRect = (chart) => {
    try {
      return chart.getModel().getComponent('grid', 0).coordinateSystem.getRect()
    } catch {
      return null
    }
  }

  const onPointerDown = useCallback((event) => {
    const chart = chartRef.current
    if (hand || event.button !== 0 || !chart || chart.isDisposed()) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const rect = plotRect(chart)
    if (!rect || !chart.containPixel('grid', [x, y])) return
    // Keeps the drag if the pointer leaves the chart. Not every pointer can be
    // captured (a synthesised or already-released one throws), and the drag still
    // works without it — it just ends where the pointer goes up over the stage.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch { /* the drag proceeds uncaptured */ }
    chart.dispatchAction({ type: 'hideTip' })
    dragRef.current = { x0: x, bounds, rect }
    setBox({ left: x, width: 0, top: rect.y, height: rect.height })
  }, [hand])

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current
    if (!drag) return
    const x = Math.max(drag.rect.x, Math.min(event.clientX - drag.bounds.left, drag.rect.x + drag.rect.width))
    setBox({
      left: Math.min(drag.x0, x), width: Math.abs(x - drag.x0), top: drag.rect.y, height: drag.rect.height,
    })
  }, [])

  const endDrag = useCallback((event, apply) => {
    const drag = dragRef.current
    dragRef.current = null
    setBox(null)
    const chart = chartRef.current
    if (!drag || !apply || !chart || chart.isDisposed()) return
    const x = Math.max(drag.rect.x, Math.min(event.clientX - drag.bounds.left, drag.rect.x + drag.rect.width))
    if (Math.abs(x - drag.x0) < MIN_BOX_PX) return
    // Through the grid, which takes a point; an axis finder takes a bare number.
    const t0 = chart.convertFromPixel('grid', [drag.x0, drag.rect.y])?.[0]
    const t1 = chart.convertFromPixel('grid', [x, drag.rect.y])?.[0]
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return
    const next = selectionToView(t0, t1, fullRef.current)
    if (next) show(next)
  }, [show])

  const stageProps = {
    'data-tool': hand ? 'hand' : 'zoom',
    onPointerDown,
    onPointerMove,
    onPointerUp: (event) => endDrag(event, true),
    onPointerCancel: (event) => endDrag(event, false),
    // Double-click is the shortcut for "show me everything again".
    onDoubleClick: reset,
  }

  return {
    onReady,
    hand,
    setHand,
    box,
    stageProps,
    currentView,
    percent: zoomPercent(viewRef.current, full),
    canZoomIn: canZoomIn(viewRef.current, full),
    canZoomOut: canZoomOut(viewRef.current, full),
    zoomIn,
    zoomOut,
    reset,
  }
}
