import {
  useEffect, useRef, useState,
} from 'react'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import CloseIcon from '@mui/icons-material/Close'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { OK_SLOT } from '@/api/cameras'
import useCameraFrameUrl from '@/components/mimic/useCameraFrameUrl'
import { clockTime } from './CameraRail'
import styles from './CameraLightbox.module.css'

// Same one-map-per-panel rule as CameraRail — see the note there.
const T = {
  dialogLabel: 'ภาพขนาดจริง',
  close: 'ปิด',
  prev: 'ภาพก่อนหน้า',
  next: 'ภาพถัดไป',
  loading: 'กำลังโหลดภาพ…',
}

function bytesLabel(bytes) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * CameraLightbox — the click-through view for one stored frame.
 *
 * The `<img>` here carries no width/height in CSS, so the browser paints it
 * at naturalWidth/naturalHeight inside a scrolling stage — an operator
 * judging a defect crop needs the pixels the vision system actually wrote,
 * not a thumbnail stretched or shrunk to fit a panel. Resolution is read off
 * that same load event and printed next to the timestamp once it lands.
 *
 * Frame identity (cameraCode/slot/index/mtime_ns) matches the strip's cache
 * key exactly, so opening a frame that is already visible as a thumbnail is
 * an instant blob-cache hit rather than a second fetch.
 */
export default function CameraLightbox({
  cameraCode, slot, frames, index, label, container, onClose, onNavigate,
}) {
  const frame = frames[index]
  const [natural, setNatural] = useState(null)
  const url = useCameraFrameUrl(cameraCode, slot, frame?.index, frame?.mtime_ns)
  const total = frames.length
  const imgRef = useRef(null)

  function readNatural(img) {
    setNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }

  useEffect(() => {
    setNatural(null)
    // The strip already fetched every frame's blob for its thumbnails, so
    // the browser usually finishes loading this <img> in the same tick it
    // mounts — before a React onLoad listener can attach to catch it. Read
    // `.complete` straight after commit as the fallback for that case;
    // onLoad below still covers a frame that is genuinely still loading.
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth) readNatural(img)
  }, [url])

  // A poll can shrink the listing out from under an open frame; close rather
  // than render a caption for data that no longer exists.
  useEffect(() => {
    if (!frame) onClose()
  }, [frame, onClose])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1)
      else if (e.key === 'ArrowRight' && index < total - 1) onNavigate(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, onNavigate])

  if (!frame) return null

  const isOk = slot === OK_SLOT
  const size = bytesLabel(frame.size_bytes)

  return (
    <Dialog
      open
      onClose={onClose}
      container={container}
      maxWidth={false}
      aria-label={`${label} — ${T.dialogLabel}`}
      slotProps={{ paper: { className: `${styles.paper} ${isOk ? styles.paperOk : ''}` } }}
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          <span className={styles.label}>{label}</span>
          <span className={styles.meta}>
            {clockTime(frame.captured_at)}
            {natural && ` · ${natural.w} × ${natural.h}px`}
            {size && ` · ${size}`}
          </span>
        </div>
        <IconButton size="small" className={styles.closeBtn} aria-label={T.close} onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>

      <div className={styles.stage}>
        <IconButton
          className={styles.navBtn}
          disabled={index <= 0}
          aria-label={T.prev}
          onClick={() => onNavigate(index - 1)}
        >
          <ChevronLeftIcon />
        </IconButton>

        <div className={styles.viewport}>
          {url
            ? (
              <img
                key={url}
                ref={imgRef}
                src={url}
                alt=""
                className={styles.img}
                onLoad={(e) => readNatural(e.currentTarget)}
              />
            )
            : <span className={styles.loading}>{T.loading}</span>}
        </div>

        <IconButton
          className={styles.navBtn}
          disabled={index >= total - 1}
          aria-label={T.next}
          onClick={() => onNavigate(index + 1)}
        >
          <ChevronRightIcon />
        </IconButton>
      </div>

      <div className={styles.foot}>
        <span className={styles.count}>{`${index + 1} / ${total}`}</span>
      </div>
    </Dialog>
  )
}
