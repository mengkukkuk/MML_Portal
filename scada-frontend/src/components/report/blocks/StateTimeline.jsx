import { useMemo } from 'react'
import * as echarts from 'echarts'
import EChart from '@/components/charts/EChart'
import ReportBlock from './ReportBlock'
import {
  STATES,
  STATE_COLORS,
  STATE_LABELS,
  fmtDuration,
  fmtDateTime,
  isMultiSource,
  machineLabel,
} from '../reportFormat'
import styles from './blocks.module.css'

/**
 * StateTimeline — the Gantt. One row per machine, one band per interval.
 *
 * An ECharts `custom` series rather than a stacked bar: the bands are absolute
 * time ranges, not cumulative quantities, and a stacked bar would silently
 * reorder them by state and destroy the sequence — which is the entire point of
 * looking at a timeline.
 *
 * Bands come straight from `machine.intervals`, the same interval set the KPIs
 * and Pareto are computed from, so the picture always matches the numbers.
 */

const ROW_HEIGHT = 26
const MIN_HEIGHT = 160

// Builds the band renderer over a specific data array. The colour is read back
// out of the item rather than via `api.style()` — that helper is deprecated in
// ECharts 6 and logs a warning on every single band drawn.
function makeRenderItem(data) {
  return function renderItem(params, api) {
    const categoryIndex = api.value(0)
    const start = api.coord([api.value(1), categoryIndex])
    const end = api.coord([api.value(2), categoryIndex])
    const height = api.size([0, 1])[1] * 0.62

    const rect = echarts.graphic.clipRectByRect(
      {
        x: start[0],
        y: start[1] - height / 2,
        width: Math.max(end[0] - start[0], 1), // a 1px floor keeps brief stops visible
        height,
      },
      {
        x: params.coordSys.x,
        y: params.coordSys.y,
        width: params.coordSys.width,
        height: params.coordSys.height,
      },
    )

    return (
      rect && {
        type: 'rect',
        transition: ['shape'],
        shape: rect,
        style: {
          fill: data[params.dataIndex]?.itemStyle?.color ?? STATE_COLORS.UNKNOWN,
          opacity: 0.95,
        },
      }
    )
  }
}

export default function StateTimeline({ block, result }) {
  const showUnknown = block?.options?.showUnknown !== false
  const machines = result?.machines ?? []

  const option = useMemo(() => {
    // The y-axis is a category axis keyed by label, so two plants that both
    // report `Line 1 / M01` would collapse onto one row and draw both plants'
    // bands as one machine's timeline. The source name is what keeps them apart.
    const multi = isMultiSource(machines)
    const categories = machines.map((m) => machineLabel(m, multi))
    const data = []

    machines.forEach((m, row) => {
      for (const iv of m.intervals ?? []) {
        if (!showUnknown && iv.state === 'UNKNOWN') continue
        data.push({
          value: [row, new Date(iv.start).getTime(), new Date(iv.end).getTime(), iv.seconds],
          itemStyle: { color: STATE_COLORS[iv.state] ?? STATE_COLORS.UNKNOWN },
          // Carried for the tooltip only — ECharts passes it through untouched.
          state: iv.state,
          reason: iv.reason,
        })
      }
    })

    return {
      animation: false,
      grid: { left: 8, right: 16, top: 8, bottom: 44, containLabel: true },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#172238',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#e6edf7', fontSize: 12 },
        formatter: (p) => {
          const d = p.data
          const color = STATE_COLORS[d.state] ?? STATE_COLORS.UNKNOWN
          const rows = [
            `<b>${categories[d.value[0]]}</b>`,
            `<span style="color:${color}">■</span> ${STATE_LABELS[d.state] ?? d.state}`,
            `${fmtDateTime(d.value[1])} → ${fmtDateTime(d.value[2])}`,
            `Duration: ${fmtDuration(d.value[3])}`,
          ]
          if (d.reason) rows.push(`Reason: ${d.reason}`)
          return rows.join('<br/>')
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
        axisLabel: { color: '#8a99b3', fontSize: 10, hideOverlap: true },
        splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      },
      yAxis: {
        type: 'category',
        data: categories,
        inverse: true,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: '#8a99b3', fontSize: 11 },
        splitLine: { show: false },
      },
      dataZoom: [
        { type: 'inside', filterMode: 'weakFilter' },
        {
          type: 'slider',
          height: 18,
          bottom: 8,
          borderColor: 'transparent',
          backgroundColor: 'rgba(255,255,255,0.04)',
          fillerColor: 'rgba(58,160,255,0.15)',
          handleStyle: { color: '#3aa0ff' },
          textStyle: { color: '#5b6a86', fontSize: 10 },
        },
      ],
      series: [
        {
          type: 'custom',
          renderItem: makeRenderItem(data),
          encode: { x: [1, 2], y: 0 },
          data,
        },
      ],
    }
  }, [machines, showUnknown])

  if (!machines.length) {
    return (
      <ReportBlock title={block?.title ?? 'Machine State Timeline'}>
        <p className={styles['block__empty']}>No machines in this window.</p>
      </ReportBlock>
    )
  }

  const height = Math.max(MIN_HEIGHT, machines.length * ROW_HEIGHT + 80)
  const visibleStates = showUnknown ? STATES : STATES.filter((s) => s !== 'UNKNOWN')

  return (
    <ReportBlock title={block?.title ?? 'Machine State Timeline'} note="Drag to zoom">
      <EChart option={option} height={`${height}px`} />
      <div className={styles.legend}>
        {visibleStates.map((s) => (
          <span key={s} className={styles['legend__item']}>
            <i className={styles['legend__swatch']} style={{ background: STATE_COLORS[s] }} />
            {STATE_LABELS[s]}
          </span>
        ))}
      </div>
    </ReportBlock>
  )
}
