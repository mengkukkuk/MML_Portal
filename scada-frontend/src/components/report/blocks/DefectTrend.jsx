import { useMemo } from 'react'
import EChart from '@/components/charts/EChart'
import { useTranslation } from '@/i18n'
import ReportBlock from './ReportBlock'
import { defectPalette, fmtPeriod } from '../reportFormat'
import styles from './blocks.module.css'

/**
 * DefectTrend — defects per period, stacked by defect type.
 *
 * The analyst's first question after "how many" is "getting better or worse,
 * and which type is driving it". A stacked bar answers both at once: the bar
 * height is the trend, the dominant colour is the driver.
 *
 * Periods come from camera_defect_logs bucketed server-side; the bucket
 * (hour/day/week) follows the window so a year stays readable. A period with
 * no defects is drawn as an empty slot rather than skipped, so a quiet week
 * reads as a gap in time, not as two busy weeks next to each other.
 */

const BUCKET_MS = { hour: 3600_000, day: 86_400_000, week: 7 * 86_400_000 }

function fillPeriods(periods, bucket) {
  const step = BUCKET_MS[bucket]
  if (!step || periods.length < 2) return periods
  const out = []
  const first = Date.parse(periods[0])
  const last = Date.parse(periods[periods.length - 1])
  // Bounded: a year of hours is never requested (the server switches bucket).
  for (let t = first; t <= last && out.length < 2000; t += step) out.push(t)
  // Buckets are local midnights/hours, so DST could shift one; fall back to
  // the server's own periods if the arithmetic lost any.
  const have = new Set(out)
  return periods.every((p) => have.has(Date.parse(p))) ? out.map((t) => new Date(t).toISOString()) : periods
}

export default function DefectTrend({ block, result }) {
  const tr = useTranslation()
  const rows = useMemo(() => result?.defect_trend ?? [], [result])
  const bucket = result?.window?.bucket ?? 'day'

  const { option, periodCount } = useMemo(() => {
    const serverPeriods = [...new Set(rows.map((r) => r.period))]
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    const periods = fillPeriods(serverPeriods, bucket)
    const index = new Map(periods.map((p, i) => [Date.parse(p), i]))
    const totals = new Map()
    rows.forEach((r) => totals.set(r.defect, (totals.get(r.defect) ?? 0) + r.count))
    // Biggest type at the bottom of the stack, where its height is easiest to read.
    const types = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a))
    const palette = defectPalette(types)

    const series = types.map((type) => {
      const data = new Array(periods.length).fill(0)
      rows.forEach((r) => {
        if (r.defect === type) data[index.get(Date.parse(r.period))] += r.count
      })
      return {
        name: type,
        type: 'bar',
        stack: 'defects',
        data,
        itemStyle: { color: palette.get(type) },
        barMaxWidth: 36,
        emphasis: { focus: 'series' },
      }
    })

    return {
      periodCount: periods.length,
      option: {
        animation: false,
        grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
        legend: {
          type: 'scroll',
          top: 0,
          textStyle: { color: '#8a99b3', fontSize: 11 },
          pageIconColor: '#8a99b3',
          pageTextStyle: { color: '#8a99b3' },
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: '#172238',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#e6edf7', fontSize: 12 },
          formatter: (params) => {
            const nonZero = params.filter((p) => p.value > 0)
            const total = nonZero.reduce((sum, p) => sum + p.value, 0)
            return [
              `<b>${fmtPeriod(periods[params[0]?.dataIndex], bucket)}</b> · ${tr('Total')} ${total.toLocaleString()}`,
              ...nonZero.map((p) => `${p.marker}${p.seriesName}: ${p.value.toLocaleString()}`),
            ].join('<br/>')
          },
        },
        xAxis: {
          type: 'category',
          data: periods.map((p) => fmtPeriod(p, bucket)),
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
          axisTick: { show: false },
          axisLabel: { color: '#8a99b3', fontSize: 10, hideOverlap: true },
        },
        yAxis: {
          type: 'value',
          name: tr('Defects'),
          nameTextStyle: { color: '#5b6a86', fontSize: 10 },
          axisLabel: { color: '#8a99b3', fontSize: 10 },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        },
        dataZoom: periods.length > 40 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 0 }] : [],
        series,
      },
    }
  }, [rows, bucket, tr])

  const bucketLabel = { hour: tr('per hour'), day: tr('per day'), week: tr('per week'), month: tr('per month') }[bucket]

  return (
    <ReportBlock
      title={tr(block?.title ?? 'Defects Over Time')}
      note={rows.length ? `${bucketLabel} · ${tr('{count} periods', { count: periodCount })}` : undefined}
    >
      {rows.length ? (
        <EChart option={option} height="320px" />
      ) : (
        <p className={styles['block__empty']}>{tr('No defects recorded in this window.')}</p>
      )}
    </ReportBlock>
  )
}
