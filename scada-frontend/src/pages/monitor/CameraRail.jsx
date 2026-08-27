import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import IconButton from '@mui/material/IconButton'
import {
  fetchCameras, fetchCameraCauseCounts, fetchCameraSnapshots, fetchCameraSummary,
} from '@/api/cameras'
import useCameraSnapshotUrl from '@/components/mimic/useCameraSnapshotUrl'
import styles from './CameraRail.module.css'

/**
 * CameraRail — the view-mode detail panel for an ipcamera symbol.
 *
 * Every Thai string used by this panel lives in this one map, on purpose:
 * the rest of the app is English (DetailRail, NodeInspector, the palette),
 * and Thai leaking into a shared file like tagStatus.js would surface on
 * every other symbol type, not just cameras.
 */
const T = {
  statusWord: { normal: 'ปกติ', warn: 'เฝ้าระวัง', crit: 'หยุด', stale: 'ไม่มีข้อมูล' },
  unboundTitle: 'ยังไม่ได้ผูกกล้องนี้',
  unboundNoLoopId:
    'สัญลักษณ์นี้ยังไม่มีรหัสกล้อง (loop id) ตั้งค่าที่แผงแก้ไข (โหมดแก้ไข → เลือกสัญลักษณ์ → Loop ID) แล้วพิมพ์รหัสให้ตรงกับกล้องที่ลงทะเบียนไว้ด้านล่าง',
  unboundWrongCode: (code) =>
    `รหัสกล้อง "${code}" ไม่ตรงกับกล้องที่ลงทะเบียนไว้ ตรวจสอบการสะกดที่แผงแก้ไข`,
  unboundNoneRegistered: 'ยังไม่มีกล้องลงทะเบียนในระบบ',
  registeredCodes: 'รหัสกล้องที่มีอยู่',
  station: 'จุดติดตั้ง',
  ngRate: 'อัตราของเสีย',
  ngRateDetail: (ng, total) => `ไม่ผ่าน ${ng.toLocaleString()} จาก ${total.toLocaleString()} ชิ้น`,
  ngFrames: 'ภาพเสียที่บันทึกไว้',
  frames: 'ภาพ',
  causesTitle: 'สาเหตุที่ไม่ผ่าน · แตะเพื่อกรอง',
  causesEmpty: 'ยังไม่มีสาเหตุที่บันทึกไว้สำหรับกล้องนี้',
  timesWord: 'ครั้ง',
  stripTitle: 'ภาพ NG ล่าสุด',
  stripFiltered: (cause) => `ภาพ NG · ${cause}`,
  clearFilter: 'แสดงทุกสาเหตุ',
  stripEmpty: 'ยังไม่มีภาพของสาเหตุนี้',
  stripEmptyAll: 'ยังไม่มีภาพ NG ที่บันทึกไว้',
  loading: 'กำลังโหลด…',
  streamTitle: 'สตรีมสด',
  streamOpen: 'เปิดสตรีมสด',
  streamNone: 'ไม่มีลิงก์สตรีมสำหรับกล้องนี้',
  scrollLeft: 'เลื่อนไปทางซ้าย',
  scrollRight: 'เลื่อนไปทางขวา',
}

const STATUS_CLASS = {
  normal: styles.pillOk, warn: styles.pillWarn, crit: styles.pillFault, stale: styles.pillStale,
}

function frameTime(ts) {
  return new Date(ts).toLocaleTimeString('th-TH', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function Frame({ cameraId, snapshot }) {
  const url = useCameraSnapshotUrl(cameraId, snapshot.id)
  return (
    <figure className={styles.frame}>
      <div className={styles.frameImg}>
        {url ? <img src={url} alt="" /> : <span className={styles.frameLoading}>NG</span>}
      </div>
      <figcaption>
        {snapshot.cause || '—'}
        <em>{frameTime(snapshot.captured_at)}</em>
      </figcaption>
    </figure>
  )
}

export default function CameraRail({ node, tag }) {
  const [causeFilter, setCauseFilter] = useState(null)
  const stripRef = useRef(null)

  const { data: cameras, isLoading: camerasLoading } = useQuery({
    queryKey: ['cameras'],
    queryFn: fetchCameras,
    staleTime: 60_000,
  })

  const loopId = node?.tagId?.trim() || null
  const camera = useMemo(() => {
    if (!cameras || !loopId) return null
    return cameras.find((c) => c.code.toLowerCase() === loopId.toLowerCase()) ?? null
  }, [cameras, loopId])

  const { data: causeCounts } = useQuery({
    queryKey: ['camera-causes', camera?.id],
    queryFn: () => fetchCameraCauseCounts(camera.id),
    enabled: !!camera,
  })

  const { data: snapshots } = useQuery({
    queryKey: ['camera-snapshots', camera?.id, causeFilter],
    queryFn: () => fetchCameraSnapshots(camera.id, { limit: 30, cause: causeFilter }),
    enabled: !!camera,
  })

  // Plant-wide total/NG, over the header's selected sources. Null (not zero)
  // until the camera has a binding — the app has no seeded plant table this
  // can read yet, so the block below falls back to the recorded-frame count.
  const { data: summary } = useQuery({
    queryKey: ['camera-summary', camera?.id],
    queryFn: () => fetchCameraSummary(camera.id),
    enabled: !!camera,
  })

  const statusClass = STATUS_CLASS[tag?.status] || styles.pillStale
  const statusWord = T.statusWord[tag?.status] || T.statusWord.stale

  const totalNg = useMemo(
    () => (causeCounts ?? []).reduce((sum, c) => sum + c.n, 0),
    [causeCounts],
  )
  const topCount = causeCounts?.[0]?.n || 0

  function toggleCause(cause) {
    setCauseFilter((cur) => (cur === cause ? null : cause))
  }

  function scrollStrip(dir) {
    const el = stripRef.current
    if (!el) return
    el.scrollBy({ left: dir * (el.clientWidth - 24), behavior: 'smooth' })
  }

  if (camerasLoading) {
    return <aside className={styles.rail}><p className={styles.quiet}>{T.loading}</p></aside>
  }

  if (!camera) {
    return (
      <aside className={styles.rail}>
        <div className={styles.head}>
          <span className={styles.eyebrow}>IP camera</span>
          <span className={styles.tagId}>{loopId || 'No loop id'}</span>
          <span className={styles.tagLabel}>{node?.label}</span>
        </div>
        <p className={styles.unboundTitle}>{T.unboundTitle}</p>
        <p className={styles.quiet}>
          {loopId ? T.unboundWrongCode(loopId) : T.unboundNoLoopId}
        </p>
        {cameras?.length ? (
          <div>
            <div className={styles.sectionTitle}>{T.registeredCodes}</div>
            <div className={styles.codeList}>
              {cameras.map((c) => <span key={c.id} className={styles.code}>{c.code}</span>)}
            </div>
          </div>
        ) : (
          <p className={styles.quiet}>{T.unboundNoneRegistered}</p>
        )}
      </aside>
    )
  }

  return (
    <aside className={styles.rail} aria-live="polite">
      <div className={styles.head}>
        <div className={styles.headRow}>
          <span className={styles.tagId}>{camera.code}</span>
          <span className={`${styles.pill} ${statusClass}`}>
            <span className={styles.dot} />
            {statusWord}
          </span>
        </div>
        <span className={styles.tagLabel}>{camera.name}</span>
        {(camera.station_code || camera.station_label) && (
          <span className={styles.eyebrow}>
            {T.station}
            {' · '}
            {[camera.station_code, camera.station_label].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      <div className={styles.ngBlock}>
        {summary?.total != null ? (
          <>
            <span className={styles.ngValue}>
              {(summary.total ? (summary.ng / summary.total) * 100 : 0).toFixed(2)}
              %
            </span>
            <span className={styles.ngLabel}>{T.ngRateDetail(summary.ng, summary.total)}</span>
          </>
        ) : (
          <>
            <span className={styles.ngValue}>{totalNg.toLocaleString()}</span>
            <span className={styles.ngLabel}>{T.ngFrames}</span>
          </>
        )}
      </div>

      <div>
        <div className={styles.sectionTitle}>{T.causesTitle}</div>
        {causeCounts?.length ? (
          <div className={styles.causes}>
            {causeCounts.map((c) => (
              <button
                key={c.cause}
                type="button"
                className={`${styles.cause} ${causeFilter === c.cause ? styles.causeOn : ''}`}
                onClick={() => toggleCause(c.cause)}
              >
                <span className={styles.causeRow}>
                  <span className={styles.causeName}>{c.cause}</span>
                  <span className={styles.causeCount}>
                    {c.n}
                    {' '}
                    {T.timesWord}
                    {totalNg ? ` · ${Math.round((c.n / totalNg) * 100)}%` : ''}
                  </span>
                </span>
                <span className={styles.track}>
                  <span
                    className={styles.trackFill}
                    style={{ width: topCount ? `${(c.n / topCount) * 100}%` : 0 }}
                  />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.quiet}>{T.causesEmpty}</p>
        )}
      </div>

      <div>
        <div className={styles.stripHead}>
          <span className={styles.sectionTitleInline}>
            {causeFilter ? T.stripFiltered(causeFilter) : T.stripTitle}
            {snapshots?.length ? ` · ${snapshots.length} ${T.frames}` : ''}
          </span>
          <span className={styles.stripNav}>
            {causeFilter && (
              <button type="button" className={styles.clearBtn} onClick={() => setCauseFilter(null)}>
                {T.clearFilter}
              </button>
            )}
            <IconButton size="small" aria-label={T.scrollLeft} onClick={() => scrollStrip(-1)}>
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <IconButton size="small" aria-label={T.scrollRight} onClick={() => scrollStrip(1)}>
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </span>
        </div>
        <div className={styles.filmWell}>
          <div className={styles.sprocket} aria-hidden="true" />
          {snapshots?.length ? (
            <div className={styles.strip} ref={stripRef}>
              {snapshots.map((s) => <Frame key={s.id} cameraId={camera.id} snapshot={s} />)}
            </div>
          ) : (
            <p className={styles.stripEmpty}>{causeFilter ? T.stripEmpty : T.stripEmptyAll}</p>
          )}
          <div className={styles.sprocket} aria-hidden="true" />
        </div>
      </div>

      <div className={styles.streamRow}>
        <span className={styles.sectionTitle}>{T.streamTitle}</span>
        {camera.stream_url ? (
          <a
            className={styles.streamLink}
            href={camera.stream_url}
            target="_blank"
            rel="noreferrer"
          >
            {T.streamOpen}
            <OpenInNewIcon fontSize="inherit" />
          </a>
        ) : (
          <span className={styles.quiet}>{T.streamNone}</span>
        )}
      </div>
    </aside>
  )
}
