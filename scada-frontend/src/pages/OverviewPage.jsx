import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined'
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined'
import StatCard from '@/components/StatCard/StatCard'
import GaugeTile from '@/components/GaugeTile/GaugeTile'
import TrendChart from '@/components/TrendChart/TrendChart'
import { fetchDevices } from '@/api/devices'
import { fetchRecentAlarms } from '@/api/alarms'
import styles from './OverviewPage.module.css'

/**
 * OverviewPage — main dashboard landing page (route: /).
 * Displays three sections:
 *   1. KPI row — StatCards for device counts (online/offline/degraded) and
 *      alarm counts (critical / unacknowledged), fetched via TanStack Query
 *      against the same endpoints the Pinia stores used to call
 *      (fetchDevices, fetchRecentAlarms) — ported off Pinia the same way
 *      DevicesPage.jsx already dropped its store for a direct useQuery.
 *   2. Gauge grid — GaugeTiles for key process values (currently hardcoded
 *      mock values, same as the Vue version; replace with live store data
 *      when API is ready).
 *   3. Trend section — TrendChart showing the last 60 minutes (mock data,
 *      generated once on mount, same as the Vue version's non-reactive
 *      computed).
 *
 * NOTE: the Vue source (OverviewPage.vue:47-49) has a pre-existing label/
 * value mismatch — the "Offline" card is bound to degradedCount and the
 * "Degraded" card to offlineCount. Carried forward verbatim for parity;
 * flagging here rather than silently fixing it.
 */
export default function OverviewPage() {
  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: fetchDevices,
  })
  const { data: alarms = [] } = useQuery({
    queryKey: ['alarms', 'recent', 10],
    queryFn: () => fetchRecentAlarms(10),
  })

  const onlineCount = devices.filter((d) => d.status === 'online').length
  const degradedCount = devices.filter((d) => d.status === 'degraded').length
  const offlineCount = devices.filter((d) => d.status === 'offline').length
  const criticalCount = alarms.filter((a) => a.severity === 'critical').length
  const unacknowledgedCount = alarms.filter((a) => !a.acknowledged).length

  const trendSeries = useMemo(() => {
    const now = Date.now()
    const points = (offset, amp, base) =>
      Array.from({ length: 60 }, (_, i) => [
        now - (59 - i) * 60_000,
        +(base + amp * Math.sin((i + offset) / 6) + (Math.random() - 0.5) * 2).toFixed(2),
      ])
    return [
      { name: 'Boiler temp (°C)', data: points(0, 8, 78) },
      { name: 'Compressor PSI', data: points(4, 6, 92) },
    ]
  }, [])

  return (
    <div className={styles.overview}>
      <section className={styles.kpis} aria-label="Key metrics">
        <StatCard
          label="Devices online"
          value={onlineCount}
          tone="ok"
          icon={<CheckCircleOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="Offline"
          value={degradedCount}
          tone="warn"
          icon={<WarningAmberOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="Degraded"
          value={offlineCount}
          tone="crit"
          icon={<CancelOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="Critical alarms"
          value={criticalCount}
          tone="crit"
          icon={<WarningRoundedIcon fontSize="small" />}
        />
        <StatCard
          label="Unacknowledged"
          value={unacknowledgedCount}
          tone="warn"
          icon={<NotificationsOutlinedIcon fontSize="small" />}
        />
      </section>

      <section className={styles.grid}>
        <GaugeTile title="Boiler temp" value={78} min={0} max={120} unit="°C" />
        <GaugeTile title="Compressor PSI" value={92} min={0} max={150} unit="" />
        <GaugeTile title="Tank 3 level" value={86} min={0} max={100} unit="%" />
      </section>

      <section className={styles.trend}>
        <TrendChart title="Last 60 minutes" series={trendSeries} />
      </section>
    </div>
  )
}
