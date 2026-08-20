import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import ReportBlock from './ReportBlock'
import { fmtDuration } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * DowntimePareto — downtime causes ranked, with the cumulative % line that
 * makes it a Pareto rather than a bar chart. The point is the 80/20 read: how
 * few causes account for most of the lost time.
 *
 * The server collapses everything past `topN` into an "Other" bucket so the
 * cumulative line still reaches 100%. `No reason logged` is deliberately left
 * in as a normal bar — it quantifies how much downtime the plant cannot
 * currently explain, which is itself an actionable finding.
 */

const BAR_COLOR = '#ef4444'
const LINE_COLOR = '#f59e0b'
const OTHER_COLOR = '#5b6a86'
const UNEXPLAINED = 'No reason logged'

export default function DowntimePareto({ block, result }) {
  const rows = result?.downtime_reasons ?? []
  const rankBy = block?.options?.rankBy ?? 'duration'
  const byCount = rankBy === 'count'

  const option = useMemo(() => {
    const labels = rows.map((r) => r.reason)
    const values = rows.map((r) => (byCount ? r.count : r.seconds / 3600))

    return {
      animation: false,
      grid: { left: 8, right: 40, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: '#172238',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#e6edf7', fontSize: 12 },
        formatter: (params) => {
          const i = params[0]?.dataIndex ?? 0
          const r = rows[i]
          if (!r) return ''
          return [
            `<b>${r.reason}</b>`,
            `Downtime: ${fmtDuration(r.seconds)}`,
            `Occurrences: ${r.count}`,
            `Cumulative: ${r.cumulative_pct?.toFixed(1)}%`,
          ].join('<br/>')
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#8a99b3',
          fontSize: 10,
          interval: 0,
          rotate: labels.length > 5 ? 30 : 0,
          width: 110,
          overflow: 'truncate',
        },
      },
      yAxis: [
        {
          type: 'value',
          name: byCount ? 'Count' : 'Hours',
          nameTextStyle: { color: '#5b6a86', fontSize: 10 },
          axisLabel: { color: '#8a99b3', fontSize: 10 },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        },
        {
          type: 'value',
          min: 0,
          max: 100,
          axisLabel: { color: '#8a99b3', fontSize: 10, formatter: '{value}%' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          type: 'bar',
          data: values.map((v, i) => ({
            value: v,
            itemStyle: {
              color:
                labels[i] === 'Other'
                  ? OTHER_COLOR
                  : labels[i] === UNEXPLAINED
                    ? LINE_COLOR
                    : BAR_COLOR,
              borderRadius: [3, 3, 0, 0],
            },
          })),
          barMaxWidth: 40,
        },
        {
          type: 'line',
          yAxisIndex: 1,
          data: rows.map((r) => Number((r.cumulative_pct ?? 0).toFixed(1))),
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: LINE_COLOR, width: 2 },
          itemStyle: { color: LINE_COLOR },
        },
      ],
    }
  }, [rows, byCount])

  return (
    <ReportBlock
      title={block?.title ?? 'Downtime Pareto'}
      note={byCount ? 'Ranked by occurrences' : 'Ranked by duration'}
    >
      {rows.length ? (
        <EChart option={option} height="300px" />
      ) : (
        <p className={styles['block__empty']}>No downtime recorded in this window.</p>
      )}
    </ReportBlock>
  )
}
