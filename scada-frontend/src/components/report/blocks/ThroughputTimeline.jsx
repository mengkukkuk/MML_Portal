import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import { cameraLabel, fmtPeriod, isMultiSource } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * Camera defect timeline — one row per camera, one cell per period, shaded by
 * how many defects that camera logged. The engineer's "when did it start, and
 * on which camera" view: a camera that goes bad shows as a row turning red
 * from a point in time, which a totals table can't show.
 *
 * Built from camera_defect_logs (the `periods` the server attaches to each
 * camera when this block is on the page), bucketed like DefectTrend. A cell
 * with no logged defects is left empty rather than painted "good": the log
 * only records batches, so absence is not proof the camera was running.
 */

const ROW_HEIGHT = 28
const MIN_HEIGHT = 160

export default function ThroughputTimeline({ block, result }) {
  const tr = useTranslation()
  const cameras = useMemo(() => result?.cameras ?? [], [result])
  const bucket = result?.window?.bucket ?? 'day'

  const { option, periodCount, max } = useMemo(() => {
    const multi = isMultiSource(cameras)
    const categories = cameras.map((c) => cameraLabel(c, multi))
    const periodList = [...new Set(cameras.flatMap((c) => (c.periods ?? []).map((p) => p.period)))]
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    const periodIndex = new Map(periodList.map((p, i) => [p, i]))
    let peak = 0
    const data = []
    cameras.forEach((c, row) => {
      for (const p of c.periods ?? []) {
        peak = Math.max(peak, p.defects)
        data.push([periodIndex.get(p.period), row, p.defects])
      }
    })

    return {
      periodCount: periodList.length,
      max: peak,
      option: {
        animation: false,
        grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
        tooltip: {
          backgroundColor: '#172238',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#e6edf7', fontSize: 12 },
          formatter: (p) => [
            `<b>${categories[p.data[1]]}</b>`,
            fmtPeriod(periodList[p.data[0]], bucket),
            `${tr('Defects')}: ${p.data[2].toLocaleString()}`,
          ].join('<br/>'),
        },
        xAxis: {
          type: 'category',
          data: periodList.map((p) => fmtPeriod(p, bucket)),
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
        visualMap: {
          min: 0,
          max: Math.max(1, peak),
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          itemHeight: 120,
          textStyle: { color: '#8a99b3', fontSize: 10 },
          inRange: { color: ['#3a4457', '#f59e0b', '#ef4444'] },
        },
        series: [
          {
            type: 'heatmap',
            data,
            itemStyle: { borderColor: 'rgba(0,0,0,0.25)', borderWidth: 1 },
          },
        ],
      },
    }
  }, [cameras, bucket, tr])

  const title = tr(block?.title ?? 'Camera Defect Timeline')

  if (!cameras.length || !periodCount) {
    return (
      <ReportBlock title={title}>
        <p className={styles['block__empty']}>{tr('No defects recorded in this window.')}</p>
      </ReportBlock>
    )
  }

  const height = Math.max(MIN_HEIGHT, cameras.length * ROW_HEIGHT + 90)

  return (
    <ReportBlock
      title={title}
      note={tr('{count} periods · peak {max} defects', { count: periodCount, max: max.toLocaleString() })}
    >
      <EChart option={option} height={`${height}px`} />
    </ReportBlock>
  )
}
