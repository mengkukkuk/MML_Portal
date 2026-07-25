import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import styles from './TrendChart.module.css'

/**
 * TrendChart — multi-series ECharts time-series line chart.
 * Props (unchanged from the Vue version):
 *   title  — optional chart heading rendered by ECharts (not a slot)
 *   series — array of { name: string, data: [timestamp, value][] }
 *   height — CSS height string for the canvas (default '280px')
 * Used on OverviewPage (last-60-min preview).
 */
export default function TrendChart({ title = '', series = [], height = '280px' }) {
  const option = useMemo(
    () => ({
      title: title
        ? { text: title, left: 0, textStyle: { color: '#e6edf7', fontSize: 14, fontWeight: 600 } }
        : undefined,
      grid: { top: 40, right: 16, bottom: 32, left: 48 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#172238',
        borderColor: '#172238',
        textStyle: { color: '#e6edf7' },
      },
      legend: { top: 8, right: 0, textStyle: { color: '#8a99b3' }, icon: 'roundRect' },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
        axisLabel: { color: '#8a99b3' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: '#8a99b3' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
        data: s.data,
      })),
    }),
    [title, series],
  )

  return (
    <div className={styles.trend}>
      <EChart className={styles.trendChart} option={option} height={height} />
    </div>
  )
}
