import { useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import IconButton from '@mui/material/IconButton'
import { fetchCameraDefectFrames } from '@/api/cameras'
import { fetchMimicCameras, fetchMimicCameraDefects } from '@/api/mimic'
import useCameraFrameUrl from '@/components/mimic/useCameraFrameUrl'
import styles from './CameraRail.module.css'

/**
 * CameraRail — the view-mode detail panel for an ipcamera symbol.
 *
 * Cameras come from the drawing's `doc.cameraDefect` binding rather than a
 * global list, which is why this needs the slug. The binding names a table in
 * the plant the header has selected, so the same rail on two drawings reads two
 * different production lines' vision schemas without either knowing about the
 * other.
 *
 * Every Thai string used by this panel lives in this one map, on purpose:
 * the rest of the app is English (DetailRail, NodeInspector, the palette),
 * and Thai leaking into a shared file like tagStatus.js would surface on
 * every other symbol type, not just cameras.
 */
const T = {
  statusWord: { normal: 'ปกติ', warn: 'เฝ้าระวัง', crit: 'หยุด', stale: 'ไม่มีข้อมูล' },
  unboundTitle: 'ยังไม่ได้ผูกกล้องนี้',
  unboundNoLink:
    'สัญลักษณ์นี้ยังไม่ได้เลือกกล้อง เข้าโหมดแก้ไข → เลือกสัญลักษณ์ → เลือกกล้องจากรายการในแผงด้านขวา',
  unboundWrongCode: (code) =>
    `รหัส "${code}" ไม่ตรงกับกล้องที่ลงทะเบียนไว้ เข้าโหมดแก้ไขแล้วเลือกกล้องจากรายการแทนการพิมพ์รหัส`,
  unboundNoneRegistered: 'ยังไม่มีกล้องในแหล่งข้อมูลที่เลือก',
  unconfiguredTitle: 'ยังไม่ได้ตั้งค่ากล้องสำหรับแผนผังนี้',
  unconfiguredHint:
    'ผู้ดูแลระบบต้องเข้าโหมดแก้ไข → ปุ่มกล้องบนแถบเครื่องมือ → เลือกตารางของเสียจากแหล่งข้อมูล',
  registeredCodes: 'รหัสกล้องที่มีอยู่',
  station: 'จุดติดตั้ง',
  linkedByLoopId: 'ผูกด้วยรหัส loop id',
  defectTotal: 'ของเสียในล็อตล่าสุด',
  batchLine: (batchId, when) => `ล็อต ${batchId ?? '—'}${when ? ` · ${when}` : ''}`,
  noBatch: 'ยังไม่มีข้อมูลล็อต',
  noBatchHint: 'ยังไม่มีการบันทึกของเสียสำหรับกล้องนี้',
  pieces: 'ชิ้น',
  slotsTitle: 'สาเหตุที่ไม่ผ่าน · แตะเพื่อกรองภาพ',
  slotsEmpty: 'ยังไม่มีสาเหตุที่บันทึกไว้สำหรับกล้องนี้',
  slotFallback: (slot) => `ตำหนิ ${slot}`,
  timesWord: 'ครั้ง',
  stripTitle: 'ภาพ NG ล่าสุด',
  stripFiltered: (label) => `ภาพ NG · ${label}`,
  clearFilter: 'แสดงทุกสาเหตุ',
  stripPickSlot: 'แตะสาเหตุด้านบนเพื่อดูภาพ',
  stripEmpty: 'ยังไม่มีภาพของสาเหตุนี้',
  frames: 'ภาพ',
  loading: 'กำลังโหลด…',
  scrollLeft: 'เลื่อนไปทางซ้าย',
  scrollRight: 'เลื่อนไปทางขวา',
}

const STATUS_CLASS = {
  normal: styles.pillOk, warn: styles.pillWarn, crit: styles.pillFault, stale: styles.pillStale,
}

/**
 * Wall-clock time, no timezone conversion.
 *
 * `camera_defect.updated_at` is a naive `timestamp` and a frame's `captured_at`
 * comes from a file mtime — both are plant-local already. Rendering them in the
 * viewer's zone would move a 09:42 reject to a time it did not happen.
 */
function clockTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('th-TH', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function slotLabel(slot) {
  return slot.label || T.slotFallback(slot.slot)
}

function Frame({ code, slot, frame, label }) {
  const url = useCameraFrameUrl(code, slot, frame.index, frame.mtime_ns)
  return (
    <figure className={styles.frame}>
      <div className={styles.frameImg}>
        {url ? <img src={url} alt="" /> : <span className={styles.frameLoading}>NG</span>}
      </div>
      <figcaption>
        {label}
        <em>{clockTime(frame.captured_at)}</em>
      </figcaption>
    </figure>
  )
}

/**
 * Floor for the two live queries.
 *
 * The page cadence goes down to 250ms because a gauge needle should track the
 * plant. Defect counters do not move at that rate — a batch advances every few
 * minutes — so re-reading them 4x a second would be pure load for an identical
 * answer. The rail follows the operator's chosen cadence but never polls
 * faster than this.
 */
const MIN_POLL_MS = 2000

export default function CameraRail({ node, tag, slug, pollMs = 5000 }) {
  const [slotFilter, setSlotFilter] = useState(null)
  const stripRef = useRef(null)

  const refetchInterval = Math.max(pollMs, MIN_POLL_MS)

  const {
    data: cameras, isLoading: camerasLoading, error: camerasError,
  } = useQuery({
    queryKey: ['mimic-cameras', slug],
    queryFn: () => fetchMimicCameras(slug),
    enabled: !!slug,
    // Identity and labels are the vision system's own configuration, not a
    // reading — they change when someone commissions a station, not when the
    // line runs. Polling them on the live cadence would be a request per tick
    // for a row that is the same all shift.
    staleTime: 60_000,
    // A drawing with no binding 404s, which is a normal state, not a fault.
    retry: false,
  })

  // The one error worth telling apart. Everything else about this rail degrades
  // to "nothing to show"; an unconfigured drawing degrades to an instruction,
  // because there is something an admin can actually do about it.
  const unconfigured = camerasError?.response?.status === 404

  /**
   * Two ways a symbol reaches its camera, and the order matters.
   *
   * `options.cameraId` is the explicit link, set from the picker in the
   * inspector. `tagId` is the older convention — type the loop id and hope it
   * matches a code — kept working because live layouts still rely on it.
   *
   * A silent fallback would be the bad kind: an operator editing one field and
   * seeing no effect because the other one is what actually resolved. So the
   * explicit link always wins, and when the legacy path is what matched, the
   * head says so.
   */
  const linkCode = node?.options?.cameraId?.trim() || null
  const loopId = node?.tagId?.trim() || null
  const wanted = linkCode || loopId

  const camera = useMemo(() => {
    if (!cameras || !wanted) return null
    return cameras.find((c) => c.code.toLowerCase() === wanted.toLowerCase()) ?? null
  }, [cameras, wanted])

  const viaLoopId = !!camera && !linkCode

  /**
   * The live pair. Both follow the page cadence rather than only loading once,
   * so a batch that advances while an operator is watching the panel updates
   * the counts under them instead of waiting for a reload.
   *
   * `placeholderData: keepPreviousData` is what makes that readable: without it
   * every tick would blank the block back to its empty state for the length of
   * a round trip, and the number would flicker instead of change. Same reason
   * useMimicPlant sets it.
   *
   * Cadence stays out of the query key. Folding it in would make every cadence
   * change a different cache entry and throw away the counts on screen.
   */
  const { data: defects } = useQuery({
    queryKey: ['mimic-camera-defects', slug, camera?.code],
    queryFn: () => fetchMimicCameraDefects(slug, camera.code),
    enabled: !!camera,
    refetchInterval,
    // A SCADA wall display must not freeze in a background tab.
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
  })

  const { data: frames } = useQuery({
    queryKey: ['camera-frames', camera?.code, slotFilter],
    queryFn: () => fetchCameraDefectFrames(camera.code, slotFilter, { limit: 30 }),
    enabled: !!camera && slotFilter != null,
    refetchInterval,
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
  })

  const slots = defects?.slots ?? []
  const topCount = useMemo(
    () => slots.reduce((max, s) => Math.max(max, s.count), 0),
    [slots],
  )
  const activeSlot = slots.find((s) => s.slot === slotFilter) ?? null

  const statusClass = STATUS_CLASS[tag?.status] || styles.pillStale
  const statusWord = T.statusWord[tag?.status] || T.statusWord.stale

  function toggleSlot(slot) {
    setSlotFilter((cur) => (cur === slot ? null : slot))
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
          <span className={styles.tagId}>{wanted || 'No camera linked'}</span>
          <span className={styles.tagLabel}>{node?.label}</span>
        </div>
        <p className={styles.unboundTitle}>
          {unconfigured ? T.unconfiguredTitle : T.unboundTitle}
        </p>
        <p className={styles.quiet}>
          {unconfigured
            ? T.unconfiguredHint
            : wanted ? T.unboundWrongCode(wanted) : T.unboundNoLink}
        </p>
        {!unconfigured && (cameras?.length ? (
          <div>
            <div className={styles.sectionTitle}>{T.registeredCodes}</div>
            <div className={styles.codeList}>
              {cameras.map((c) => <span key={c.code} className={styles.code}>{c.code}</span>)}
            </div>
          </div>
        ) : (
          <p className={styles.quiet}>{T.unboundNoneRegistered}</p>
        ))}
      </aside>
    )
  }

  const hasBatch = defects?.batch_id != null || (defects?.total ?? 0) > 0

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
        {camera.station && (
          <span className={styles.eyebrow}>
            {T.station}
            {' · '}
            {camera.station}
          </span>
        )}
        {viaLoopId && <span className={styles.legacyNote}>{T.linkedByLoopId}</span>}
      </div>

      <div className={styles.ngBlock}>
        {hasBatch ? (
          <>
            <span className={styles.ngValue}>
              {(defects?.total ?? 0).toLocaleString()}
            </span>
            <span className={styles.ngLabel}>
              {T.defectTotal}
              {' · '}
              {T.batchLine(defects?.batch_id, clockTime(defects?.updated_at))}
            </span>
          </>
        ) : (
          <>
            <span className={styles.ngValueQuiet}>{T.noBatch}</span>
            <span className={styles.ngLabel}>{T.noBatchHint}</span>
          </>
        )}
      </div>

      <div>
        <div className={styles.sectionTitle}>{T.slotsTitle}</div>
        {slots.length ? (
          <div className={styles.causes}>
            {slots.map((s) => (
              <button
                key={s.slot}
                type="button"
                className={`${styles.cause} ${slotFilter === s.slot ? styles.causeOn : ''}`}
                aria-pressed={slotFilter === s.slot}
                onClick={() => toggleSlot(s.slot)}
              >
                <span className={styles.causeRow}>
                  <span className={styles.causeName}>{slotLabel(s)}</span>
                  <span className={styles.causeCount}>
                    {s.count}
                    {' '}
                    {T.timesWord}
                    {defects?.total ? ` · ${Math.round((s.count / defects.total) * 100)}%` : ''}
                  </span>
                </span>
                <span className={styles.track}>
                  <span
                    className={styles.trackFill}
                    style={{ width: topCount ? `${(s.count / topCount) * 100}%` : 0 }}
                  />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.quiet}>{T.slotsEmpty}</p>
        )}
      </div>

      <div>
        <div className={styles.stripHead}>
          <span className={styles.sectionTitleInline}>
            {activeSlot ? T.stripFiltered(slotLabel(activeSlot)) : T.stripTitle}
            {frames?.length ? ` · ${frames.length} ${T.frames}` : ''}
          </span>
          <span className={styles.stripNav}>
            {slotFilter != null && (
              <button type="button" className={styles.clearBtn} onClick={() => setSlotFilter(null)}>
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
          {slotFilter == null ? (
            <p className={styles.stripEmpty}>{T.stripPickSlot}</p>
          ) : frames?.length ? (
            <div className={styles.strip} ref={stripRef}>
              {frames.map((f) => (
                <Frame
                  key={`${f.index}-${f.mtime_ns}`}
                  code={camera.code}
                  slot={slotFilter}
                  frame={f}
                  label={activeSlot ? slotLabel(activeSlot) : ''}
                />
              ))}
            </div>
          ) : (
            <p className={styles.stripEmpty}>{T.stripEmpty}</p>
          )}
          <div className={styles.sprocket} aria-hidden="true" />
        </div>
      </div>
    </aside>
  )
}
