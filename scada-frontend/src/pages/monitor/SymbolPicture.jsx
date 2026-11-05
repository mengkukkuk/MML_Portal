import { useRef, useState } from 'react'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import useAssetUrl from '@/components/mimic/useAssetUrl'
import {
  SKIN_ACCEPT, SKIN_MAX_BYTES, formatSize, isSkinnable, skinAssetId, skinPatch,
} from '@/components/mimic/symbolSkin'
import { uploadSkin } from './skinUpload'
import inspector from './NodeInspector.module.css'
import styles from './SymbolPicture.module.css'

/**
 * SymbolPicture — swap one symbol's artwork for an image, keeping everything else.
 *
 * The data source, wires, size, rotation and balloon are untouched: this only
 * decides what the symbol looks like. The picture is stored on the node as an
 * asset id, so the same upload is reused if it is picked again (the server
 * matches on content) and "use the drawn symbol" is one click back.
 */
export default function SymbolPicture({ node, def, onOptions }) {
  const assetId = skinAssetId(node)
  const url = useAssetUrl(assetId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  if (!isSkinnable(def)) {
    return (
      <div className={inspector.section}>
        <div className={inspector.sectionTitle}>Picture</div>
        <p className={inspector.hint}>
          {def?.category === 'custom'
            ? 'This symbol already is a picture. Change it from the symbol library.'
            : 'This symbol is its own readout, so there is no artwork to replace.'}
        </p>
      </div>
    )
  }

  const pick = async (file) => {
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      const asset = await uploadSkin(file)
      onOptions(skinPatch(asset.id))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
      // Allow picking the same file again after a failure or a removal.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const choose = () => inputRef.current?.click()

  return (
    <div className={inspector.section}>
      <div className={inspector.sectionTitle}>Picture</div>
      <p className={inspector.hint}>
        Show this symbol as your own image. It keeps its data source, wires,
        status frame and reading — only the drawing changes.
      </p>

      <button
        type="button"
        className={`${styles.drop} ${assetId ? styles.dropFilled : ''}`}
        disabled={busy}
        onClick={choose}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]) }}
        aria-label={assetId ? 'Replace the picture' : 'Choose a picture'}
      >
        {url
          ? <img className={styles.thumb} src={url} alt="" />
          : (
            <span className={styles.dropHint}>
              {busy ? 'Uploading…' : 'Drop an image here, or click to choose one'}
              <em>PNG, JPG, BMP or GIF · up to {formatSize(SKIN_MAX_BYTES)}</em>
            </span>
          )}
      </button>

      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept={SKIN_ACCEPT}
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {error && <Alert severity="error">{error}</Alert>}

      {assetId && (
        <>
          <Button fullWidth color="inherit" disabled={busy} onClick={choose}>
            {busy ? 'Uploading…' : 'Replace picture'}
          </Button>
          <Button
            fullWidth
            color="inherit"
            startIcon={<RestartAltOutlined />}
            disabled={busy}
            onClick={() => onOptions(skinPatch(null))}
          >
            Use the drawn symbol
          </Button>
          {/* An animated GIF is the one thing the pause-on-stop freeze cannot
              reach: the drawn symbols stop their motion with the plant, a GIF
              keeps playing. Worth saying where it is chosen. */}
          <p className={inspector.hint}>
            An animated GIF keeps playing when the equipment stops.
          </p>
        </>
      )}
    </div>
  )
}
