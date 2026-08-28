import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import CloseOutlined from '@mui/icons-material/CloseOutlined'
import { fetchMimicProductionLog } from '@/api/mimic'
import { apiErrorMessage } from '@/api/client'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'
import {
  defaultProductionHour, formatRejectRate, PRODUCTION_LOG_COPY,
  productionBarHeight, productionHourIsFuture,
} from './productionLog'
import styles from './ProductionLogDrawer.module.css'


const N = new Intl.NumberFormat('th-TH')

function bilingual(thai, english) {
  return <>{thai}<small>{english}</small></>
}

export default function ProductionLogDrawer({ open, slug, configured, canEdit, onClose }) {
  const [selectedHour, setSelectedHour] = useState(null)
  const selectionKey = useDatasourceSelectionStore((state) => state.selectionKey)
  const query = useQuery({
    queryKey: ['mimic-production-log', slug, selectionKey],
    queryFn: () => fetchMimicProductionLog(slug),
    enabled: open && !!slug && configured,
    refetchInterval: open && configured ? 60_000 : false,
  })

  useEffect(() => {
    if (!query.data) return
    setSelectedHour((current) => (
      query.data.buckets.some((bucket) => bucket.hour === current)
        ? current
        : defaultProductionHour(query.data)
    ))
  }, [query.data])

  const selected = query.data?.buckets.find((bucket) => bucket.hour === selectedHour)
    ?? query.data?.buckets[0]
  const maxProduced = useMemo(
    () => Math.max(0, ...(query.data?.buckets ?? []).map((bucket) => bucket.produced)),
    [query.data],
  )
  const failedSources = query.data?.sources?.filter((source) => !source.ok) ?? []
  const noProduction = query.data?.buckets.every(
    (bucket) => bucket.produced === 0 && bucket.rejected === 0,
  )

  return (
    <section
      id="mimic-production-log"
      className={`${styles.drawer} ${open ? styles.drawerOpen : ''}`}
      aria-hidden={!open}
      aria-label="บันทึกผลผลิตรายชั่วโมง / Hourly production log"
      inert={!open ? true : undefined}
    >
      <header className={styles.head}>
        <div>
          <h3>{bilingual(...PRODUCTION_LOG_COPY.heading)}</h3>
          <p>{bilingual('แตะแท่งเพื่อดูตัวเลข', 'Select a bar to inspect the hour')}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="ปิด / Close production log">
          <CloseOutlined fontSize="small" />
        </button>
      </header>

      {!configured && (
        <div className={styles.message} role="status">
          <strong>{bilingual('ยังไม่ได้ตั้งค่าบันทึกผลผลิต', 'Production log is not configured')}</strong>
          <span>
            {canEdit
              ? 'ตั้งค่าแหล่งข้อมูลในโหมดแก้ไข / Configure its data source in Edit mode.'
              : 'โปรดติดต่อผู้ดูแลระบบ / Ask an administrator to configure this mimic.'}
          </span>
        </div>
      )}

      {configured && query.isPending && !query.data && (
        <div className={styles.message} role="status">กำลังโหลด / Loading…</div>
      )}

      {configured && query.isError && !query.data && (
        <div className={`${styles.message} ${styles.messageError}`} role="alert">
          <strong>{bilingual('โหลดข้อมูลไม่ได้', 'Could not load production data')}</strong>
          <span>{apiErrorMessage(query.error)}</span>
        </div>
      )}

      {configured && query.data && selected && (
        <div className={styles.content} aria-busy={query.isFetching}>
          <div className={styles.summary} aria-live="polite">
            <time>{String(selected.hour).padStart(2, '0')}:00</time>
            <span>{bilingual(...PRODUCTION_LOG_COPY.good)} <b>{N.format(selected.produced)}</b></span>
            <span>{bilingual(...PRODUCTION_LOG_COPY.reject)} <b className={styles.rejectValue}>{N.format(selected.rejected)}</b></span>
            <span>{bilingual(...PRODUCTION_LOG_COPY.rejectRate)} <b>{formatRejectRate(selected)}</b></span>
            {query.isFetching && <em>กำลังอัปเดต / Updating…</em>}
            {query.isError && <em className={styles.stale}>ข้อมูลเดิม / Last known data</em>}
            {failedSources.length > 0 && (
              <em className={styles.warning} title={failedSources.map((source) => source.error).join('\n')}>
                บางแหล่งข้อมูลขัดข้อง / Partial source failure
              </em>
            )}
          </div>

          <div className={styles.chart} role="group" aria-label="ผลผลิตแยกตามชั่วโมง / Production by hour">
            {query.data.buckets.map((bucket) => {
              const active = bucket.hour === selected.hour
              const future = productionHourIsFuture(query.data, bucket.hour)
              const height = productionBarHeight(bucket.produced, maxProduced)
              const label = `${bucket.label}:00, good ${bucket.produced}, rejected ${bucket.rejected}, reject rate ${formatRejectRate(bucket)}`
              return (
                <button
                  key={bucket.hour}
                  type="button"
                  className={`${styles.barSlot} ${active ? styles.barSlotActive : ''} ${future ? styles.barSlotFuture : ''}`}
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => setSelectedHour(bucket.hour)}
                >
                  <span className={styles.barWell} aria-hidden="true">
                    <span className={styles.bar} style={{ height: height ? `${height}%` : '2px' }}>
                      {bucket.rejected > 0 && <span className={styles.rejectCap} />}
                    </span>
                  </span>
                  <span className={styles.hour}>{bucket.label}</span>
                </button>
              )
            })}
          </div>

          {noProduction && (
            <p className={styles.empty}>{PRODUCTION_LOG_COPY.empty.join(' / ')}</p>
          )}
        </div>
      )}
    </section>
  )
}
