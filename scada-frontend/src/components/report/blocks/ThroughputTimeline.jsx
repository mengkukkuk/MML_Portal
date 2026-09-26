import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import ReportBlock from './ReportBlock'
import { cameraLabel, fmtDateTime, isMultiSource } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * ThroughputTimeline — one row per camera, one cell per hour, coloured by
 * defect rate. A heatmap rather than a Gantt: vision data has no discrete
 * machine states, just a continuous count_total/defect_total pair per hour, so
 * the interesting signal is "how bad was this hour", not "which state was
 * active".
 *
 * Cell colour comes straight from the same rate the KPI/summary blocks report,
 * so the picture always matches the numbers. An hour with zero inspected units
 * (a gap, not a good hour) renders as a distinct neutral colour rather than a
 * false "0% defects" green.
 */

const ROW_HEIGHT = 26
const MIN_HEIGHT = 160
const GAP_COLOR = '#3a4457'

function rateColor(rate) {
  if (rate == null) return GAP_COLOR
  if (rate >= 5) return '#ef4444'
  if (rate >= 2) return '#f59e0b'
  return '#22c55e'
}

export default function ThroughputTimeline({ block, result }) {
  const cameras = result?.cameras ?? []

  const { option, hours } = useMemo(() => {
    const multi = isMultiSource(cameras)
    const categories = cameras.map((c) => cameraLabel(c, multi))
    const hourSet = new Set()
    cameras.forEach((c) => (c.hourly ?? []).forEach((h) => hourSet.add(h.period_start)))
    const hourList = [...hourSet].sort()
    const hourIndex = new Map(hourList.map((h, i) => [h, i]))

    const data = []
    cameras.forEach((c, row) => {
      for (const h of c.hourly ?? []) {
        const rate = h.count_total > 0 ? (h.defect_total / h.count_total) * 100 : null
        data.push({
          value: [hourIndex.get(h.period_start), row, rate],
          period_start: h.period_start,
          count_total: h.count_total,
          defect_total: h.defect_total,
        })
      }
    })

    return {
      hours: hourList,
      option: {
        animation: false,
        grid: { left: 8, right: 16, top: 8, bottom: 40, containLabel: true },
        tooltip: {
          backgroundColor: '#172238',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#e6edf7', fontSize: 12 },
          formatter: (p) => {
            const d = p.data
            const rate = d.value[2]
            return [
              `<b>${categories[d.value[1]]}</b>`,
              fmtDateTime(d.period_start),
              d.count_total > 0
                ? `Inspected: ${d.count_total} · Defects: ${d.defect_total} · ${rate.toFixed(1)}%`
                : 'No data this hour',
            ].join('<br/>')
          },
        },
        xAxis: {
          type: 'category',
          data: hourList.map((h) => fmtDateTime(h)),
          splitArea: { show: false },
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
          axisLabel: { color: '#8a99b3', fontSize: 9, hideOverlap: true },
        },
        yAxis: {
          type: 'category',
          data: categories,
          inverse: true,
          axisTick: { show: false },
          axisLine: { show: false },
          axisLabel: { color: '#8a99b3', fontSize: 11 },
        },
        series: [
          {
            type: 'heatmap',
            data: data.map((d) => ({
              value: d.value,
              period_start: d.period_start,
              count_total: d.count_total,
              defect_total: d.defect_total,
              itemStyle: { color: rateColor(d.value[2]) },
            })),
            itemStyle: { borderColor: 'rgba(0,0,0,0.25)', borderWidth: 1 },
          },
        ],
      },
    }
  }, [cameras])

  if (!cameras.length) {
    return (
      <ReportBlock title={block?.title ?? 'Camera Throughput Timeline'}>
        <p className={styles['block__empty']}>No cameras in this window.</p>
      </ReportBlock>
    )
  }

  const height = Math.max(MIN_HEIGHT, cameras.length * ROW_HEIGHT + 60)

  return (
    <ReportBlock title={block?.title ?? 'Camera Throughput Timeline'} note={`${hours.length} hours`}>
      <EChart option={option} height={`${height}px`} />
      <div className={styles.legend}>
        <span className={styles['legend__item']}>
          <i className={styles['legend__swatch']} style={{ background: '#22c55e' }} /> &lt; 2%
        </span>
        <span className={styles['legend__item']}>
          <i className={styles['legend__swatch']} style={{ background: '#f59e0b' }} /> 2–5%
        </span>
        <span className={styles['legend__item']}>
          <i className={styles['legend__swatch']} style={{ background: '#ef4444' }} /> ≥ 5%
        </span>
        <span className={styles['legend__item']}>
          <i className={styles['legend__swatch']} style={{ background: GAP_COLOR }} /> No data
        </span>
      </div>
    </ReportBlock>
  )
}
