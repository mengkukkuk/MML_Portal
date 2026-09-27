import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import styles from './blocks.module.css'

/**
 * DefectPareto — defect types ranked, with the cumulative % line that makes it
 * a Pareto rather than a bar chart. The point is the 80/20 read: how few
 * defect types account for most of the flagged units.
 *
 * The server collapses everything past `topN` into an "Other" bucket so the
 * cumulative line still reaches 100%.
 */

const BAR_COLOR = '#ef4444'
const LINE_COLOR = '#f59e0b'
const OTHER_COLOR = '#5b6a86'

export default function DefectPareto({ block, result }) {
  const tr = useTranslation()
  const rows = useMemo(() => result?.defect_reasons ?? [], [result])
  const rankBy = block?.options?.rankBy ?? 'count'
  const byBatches = rankBy === 'batches'

  const option = useMemo(() => {
    // "Other" is the server's tail bucket, the one label here that is ours to
    // translate; every other label is a plant's own defect name.
    const labels = rows.map((r) => (r.defect === 'Other' ? tr('Other') : r.defect))
    const values = rows.map((r) => (byBatches ? r.batches : r.count))

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
            `<b>${labels[i]}</b>`,
            `${tr('Count')}: ${r.count.toLocaleString()}`,
            `${tr('Batches')}: ${r.batches.toLocaleString()}`,
            `${tr('Cumulative')}: ${r.cumulative_pct?.toFixed(1)}%`,
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
          name: byBatches ? tr('Batches') : tr('Count'),
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
              color: rows[i].defect === 'Other' ? OTHER_COLOR : BAR_COLOR,
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
  }, [rows, byBatches, tr])

  return (
    <ReportBlock
      title={tr(block?.title ?? 'Defect Pareto')}
      note={byBatches ? tr('Ranked by batches') : tr('Ranked by count')}
    >
      {rows.length ? (
        <EChart option={option} height="300px" />
      ) : (
        <p className={styles['block__empty']}>{tr('No defects recorded in this window.')}</p>
      )}
    </ReportBlock>
  )
}
