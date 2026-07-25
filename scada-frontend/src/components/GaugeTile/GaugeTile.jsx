import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import styles from './GaugeTile.module.css'

/**
 * GaugeTile — ECharts arc-gauge card for a single numeric reading.
 * Props (unchanged from the Vue version): title, value, min (default 0),
 * max (default 100), unit (string suffix).
 * Renders a 220px canvas gauge with a blue progress arc; no pointer shown.
 * Used on OverviewPage for key process values (temperature, pressure, level).
 */
export default function GaugeTile({ title = '', value = 0, min = 0, max = 100, unit = '' }) {
  const option = useMemo(
    () => ({
      series: [
        {
          type: 'gauge',
          min,
          max,
          startAngle: 210,
          endAngle: -30,
          progress: { show: true, width: 14, roundCap: true, itemStyle: { color: '#3aa0ff' } },
          axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(255,255,255,0.08)']] } },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          anchor: { show: false },
          title: {
            offsetCenter: [0, '78%'],
            color: '#8a99b3',
            fontSize: 12,
          },
          detail: {
            offsetCenter: [0, '0%'],
            color: '#e6edf7',
            fontSize: 26,
            fontWeight: 600,
            formatter: (v) => `${Math.round(v)}${unit}`,
          },
          data: [{ value, name: title }],
        },
      ],
    }),
    [min, max, value, unit, title],
  )

  return (
    <div className={styles.gauge}>
      <EChart className={styles.gaugeChart} option={option} height="220px" />
    </div>
  )
}
