import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

/**
 * EChart — thin, generic wrapper around the ECharts core (raw `echarts`
 * package, not `echarts-for-react`) chosen over the latter for precise
 * control of the three failure modes called out in the migration plan:
 *
 *   1. Double-init under StrictMode's mount→unmount→mount dev cycle —
 *      solved with `getInstanceByDom(el) ?? init(el)` on mount and
 *      `dispose()` in the effect cleanup, so the "fake" unmount tears the
 *      instance all the way down instead of leaking a second live chart.
 *   2. Stale options when swapping option "shapes" (e.g. a future
 *      heatmap→timeseries panel switch in LivePanel) — solved by always
 *      calling `setOption(option, { notMerge: true, lazyUpdate: true })`
 *      so a new option object never inherits a previous series/axis/
 *      visualMap it didn't explicitly declare.
 *   3. Stale chart size — react-grid-layout (Phase 6) and the sidebar
 *      collapse animation both resize this element via inline styles with
 *      no `window.resize` event, so ECharts never learns its container
 *      changed size on its own. This wrapper owns a `ResizeObserver` on
 *      its own container div, rAF-debounced, and skips `chart.resize()`
 *      entirely when the observed box is 0×0 (mid unmount/collapse
 *      transition) to avoid ECharts throwing on a zero-size canvas.
 *
 * Props:
 *   option    — ECharts option object (required)
 *   height    — CSS height for the container (default '100%')
 *   width     — CSS width for the container (default '100%')
 *   className — optional className applied to the container div
 *   style     — optional extra inline styles merged onto the container
 *   notMerge  — passed through to setOption (default true, see above)
 *   theme     — optional echarts theme name/object passed to init()
 *   onEvents  — optional { eventName: handler } map bound via chart.on()
 *
 * Kept intentionally generic/reusable — Phase 5's LivePanel (12 viz types)
 * will be the heaviest consumer of this component.
 */
export default function EChart({
  option,
  height = '100%',
  width = '100%',
  className,
  style,
  notMerge = true,
  theme,
  onEvents,
}) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)

  // Mount/dispose the chart instance itself. Deliberately does not depend
  // on `option` — only re-inits if the theme changes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    const chart = echarts.getInstanceByDom(el) ?? echarts.init(el, theme)
    chartRef.current = chart

    return () => {
      chart.dispose()
      if (chartRef.current === chart) chartRef.current = null
    }
  }, [theme])

  // Apply the option. Runs after the init effect above within the same
  // commit, so chartRef.current is always populated by the time this runs.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || chart.isDisposed()) return
    chart.setOption(option ?? {}, { notMerge, lazyUpdate: true })
  }, [option, notMerge])

  // Bind/rebind user event handlers.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || chart.isDisposed() || !onEvents) return undefined

    const entries = Object.entries(onEvents)
    entries.forEach(([name, handler]) => chart.on(name, handler))
    return () => {
      entries.forEach(([name, handler]) => chart.off(name, handler))
    }
  }, [onEvents])

  // Own ResizeObserver, rAF-debounced, guarded against 0x0 during
  // unmount/collapse transitions (react-grid-layout / sidebar collapse).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined

    let rafId = null
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = null
        const { width: w, height: h } = entry.contentRect
        if (w <= 0 || h <= 0) return
        const chart = chartRef.current
        if (chart && !chart.isDisposed()) chart.resize()
      })
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width, height, ...style }}
    />
  )
}
