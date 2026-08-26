import { useCallback, useEffect, useRef, useState } from 'react'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import DeleteOutline from '@mui/icons-material/DeleteOutline'
import { DYNAMICS, DYNAMIC_KINDS, newDynamic } from '@/components/mimic/symbols/dynamics'
import { customDescriptor } from '@/components/mimic/symbols'
import CustomSymbol from '@/components/mimic/symbols/CustomSymbol'
import { createMimicSymbol, uploadMimicAsset } from '@/api/mimicAssets'
import { apiErrorMessage } from '@/api/client'
import styles from './CustomSymbolDialog.module.css'

const MAX_KB = 512

/**
 * A tag that ticks, for the preview.
 *
 * The dynamics are all driven by a live reading, so a still preview would show an
 * admin nothing about the thing they are configuring — "rotate while running"
 * looks identical to "stroke while running" on a frozen picture. This drives the
 * real renderer with a real-shaped tag entry (see tagStatus.js) so what appears in
 * the preview is literally what the canvas will draw.
 */
function usePreviewTag(alarm) {
  const [t, setT] = useState(0)

  useEffect(() => {
    const h = setInterval(() => setT((v) => v + 1), 900)
    return () => clearInterval(h)
  }, [])

  // A slow triangle wave over 0..100, so a fill visibly rises and falls and a
  // `turn` sweeps both ways rather than snapping back at the top.
  const phase = (t % 20) / 10
  const value = Math.round((phase <= 1 ? phase : 2 - phase) * 100)

  return {
    id: 'PREVIEW',
    label: 'Preview',
    unit: '',
    kind: 'both',
    decimals: 0,
    range: [0, 100],
    limits: {
      warnLo: null, warnHi: null, critLo: null, critHi: null,
    },
    value,
    prevValue: value,
    display: value,
    prevDisplay: value,
    // Cycles through the three states a `swap` map is most often keyed on, so a
    // multi-state symbol can be checked without wiring it to a plant first.
    state: t % 12 < 8 ? 'run' : 'stop',
    status: alarm ? 'crit' : 'normal',
    prevStatus: 'normal',
    pulse: t,
    ts: Date.now(),
  }
}

/**
 * CustomSymbolDialog — author one library symbol from an uploaded picture.
 *
 * Two things happen here, in order: the image is uploaded (becoming an asset),
 * then a definition is saved that points at it and lists its dynamics. They are
 * separate calls because they are separate objects — the same picture can back
 * several symbols, and re-uploading a file the server already holds returns the
 * existing asset instead of a duplicate.
 *
 * The preview is the point of the dialog. Motion is hard to describe and easy to
 * recognise, so rather than explaining what "stroke while running" does, this
 * renders it, driven by a fake ticking tag, through the same CustomSymbol the
 * canvas uses.
 */
export default function CustomSymbolDialog({ open, container, onClose, onSaved }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [name, setName] = useState('')
  const [size, setSize] = useState({ w: 120, h: 120 })
  const [binding, setBinding] = useState('both')
  const [dynamics, setDynamics] = useState([])
  const [alarm, setAlarm] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  const tag = usePreviewTag(alarm)

  const reset = useCallback(() => {
    setFile(null)
    setPreview(null)
    setName('')
    setSize({ w: 120, h: 120 })
    setBinding('both')
    setDynamics([])
    setAlarm(false)
    setError(null)
  }, [])

  // The picture is previewed from the local file, before any upload: an admin
  // should see what they picked without a round trip, and without a half-authored
  // asset landing in the library if they change their mind.
  useEffect(() => {
    if (!file) { setPreview(null); return undefined }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const pickFile = (f) => {
    setError(null)
    if (!f) return
    if (f.size > MAX_KB * 1024) {
      setError(`${f.name} is ${Math.round(f.size / 1024)} KB. The limit is ${MAX_KB} KB.`)
      return
    }
    setFile(f)
    // Seed the name from the filename minus its extension — almost always what
    // the symbol should be called, and always editable.
    if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 80))
  }

  const addDynamic = (kind) => {
    const dyn = newDynamic(kind)
    if (dyn) setDynamics((prev) => [...prev, dyn])
  }

  const setField = (i, field, value) => setDynamics((prev) => prev.map(
    (d, j) => (j === i ? { ...d, [field]: value } : d),
  ))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const asset = await uploadMimicAsset(file)
      const row = await createMimicSymbol({
        name: name.trim(),
        asset_id: asset.id,
        w: Math.round(size.w),
        h: Math.round(size.h),
        ports: {},
        dynamics,
        binding,
        bubble: null,
      })
      reset()
      onSaved(row)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not save the symbol.'))
    } finally {
      setSaving(false)
    }
  }

  // A descriptor built exactly as the registry would build it, with the local
  // blob standing in for the asset that does not exist yet.
  const previewDef = {
    ...customDescriptor({
      id: -1, name, asset_id: null, w: size.w, h: size.h, ports: {}, dynamics, binding, bubble: null,
    }),
    previewUrl: preview,
  }

  const canSave = !!file && name.trim().length > 0 && !saving

  return (
    <Dialog open={open} container={container} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Add a symbol from an image</DialogTitle>

      <DialogContent dividers>
        <div className={styles.body}>
          {/* --- left: the picture and what it is ------------------------- */}
          <div className={styles.col}>
            <span className={styles.head}>Picture</span>

            <button
              type="button"
              className={`${styles.drop} ${file ? styles.dropFilled : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]) }}
            >
              {preview
                ? <img className={styles.thumb} src={preview} alt="" />
                : (
                  <span className={styles.dropHint}>
                    Drop an image here, or click to choose one
                    <em>PNG, JPEG, WebP or SVG · up to {MAX_KB} KB</em>
                  </span>
                )}
            </button>

            <input
              ref={inputRef}
              className={styles.hiddenInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />

            <label className={styles.field}>
              <span>Name</span>
              <input
                className={styles.input}
                value={name}
                maxLength={80}
                placeholder="e.g. Chiller CH-1"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className={styles.row}>
              <label className={styles.field}>
                <span>Width</span>
                <input
                  className={styles.input}
                  type="number"
                  min={16}
                  max={900}
                  value={size.w}
                  onChange={(e) => setSize((p) => ({ ...p, w: Number(e.target.value) }))}
                />
              </label>
              <label className={styles.field}>
                <span>Height</span>
                <input
                  className={styles.input}
                  type="number"
                  min={16}
                  max={900}
                  value={size.h}
                  onChange={(e) => setSize((p) => ({ ...p, h: Number(e.target.value) }))}
                />
              </label>
            </div>

            <label className={styles.field}>
              <span>Reads</span>
              <select
                className={styles.input}
                value={binding}
                onChange={(e) => setBinding(e.target.value)}
              >
                <option value="both">A value and a run/stop state</option>
                <option value="analog">A value only</option>
                <option value="discrete">A state only</option>
                <option value="none">Nothing — decoration</option>
              </select>
            </label>

            <Alert severity="info" className={styles.note}>
              An uploaded picture keeps its own colours: unlike the drawn symbols, it will not
              re-colour when the theme changes. Status shows in the frame around it and in its
              instrument balloon.
            </Alert>
          </div>

          {/* --- right: motion, and what it looks like -------------------- */}
          <div className={styles.col}>
            <span className={styles.head}>Motion</span>
            <p className={styles.hint}>
              Motion comes from the tag, not from the file — so a pump turns because the pump is
              running, and stops where it stopped.
            </p>

            <div className={styles.kinds}>
              {DYNAMIC_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={styles.kindBtn}
                  onClick={() => addDynamic(kind)}
                  title={DYNAMICS[kind].hint}
                >
                  + {DYNAMICS[kind].label}
                </button>
              ))}
            </div>

            {dynamics.length === 0 && (
              <p className={styles.empty}>
                No motion yet. The symbol will sit still and show its reading.
              </p>
            )}

            {dynamics.map((dyn, i) => {
              const def = DYNAMICS[dyn.kind]
              return (
                <div key={`${dyn.kind}-${i}`} className={styles.dyn}>
                  <div className={styles.dynHead}>
                    <span className={styles.dynName}>{def.label}</span>
                    <span className={styles.dynReads}>reads {def.reads}</span>
                    <button
                      type="button"
                      className={styles.dynDel}
                      aria-label={`Remove ${def.label}`}
                      onClick={() => setDynamics((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <DeleteOutline fontSize="small" />
                    </button>
                  </div>
                  <p className={styles.dynHint}>{def.hint}</p>

                  {def.fields.length > 0 && (
                    <div className={styles.dynFields}>
                      {def.fields.filter((f) => f.type !== 'assetMap').map((f) => (
                        <label key={f.name} className={styles.field}>
                          <span>{f.label}</span>
                          {f.type === 'select'
                            ? (
                              <select
                                className={styles.input}
                                value={dyn[f.name] ?? f.default}
                                onChange={(e) => setField(i, f.name, e.target.value)}
                              >
                                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            )
                            : (
                              <input
                                className={styles.input}
                                type="number"
                                value={dyn[f.name] ?? f.default}
                                onChange={(e) => setField(i, f.name, Number(e.target.value))}
                              />
                            )}
                        </label>
                      ))}
                    </div>
                  )}

                  {/* The state→image map needs several uploads to point at, which
                      this dialog cannot collect while authoring the first one.
                      Say so rather than showing a control that cannot work yet. */}
                  {def.fields.some((f) => f.type === 'assetMap') && (
                    <p className={styles.dynHint}>
                      Add the extra pictures from the symbol library once this symbol is saved.
                    </p>
                  )}
                </div>
              )
            })}

            <span className={styles.head}>Preview</span>
            <div className={styles.previewWrap}>
              <svg
                className={styles.previewSvg}
                viewBox={`-14 -14 ${size.w + 28} ${size.h + 46}`}
                preserveAspectRatio="xMidYMid meet"
                aria-label="Symbol preview"
              >
                <CustomSymbol
                  node={{
                    id: 'preview', type: 'custom', label: name || 'Symbol', w: size.w, h: size.h,
                  }}
                  def={previewDef}
                  tag={tag}
                />
              </svg>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={alarm}
                  onChange={(e) => setAlarm(e.target.checked)}
                />
                Show it in alarm
              </label>
            </div>
          </div>
        </div>

        {error && <Alert severity="error" className={styles.note}>{error}</Alert>}
      </DialogContent>

      <DialogActions>
        <Button color="inherit" onClick={() => { reset(); onClose() }}>Cancel</Button>
        <Button variant="contained" loading={saving} disabled={!canSave} onClick={save}>
          Add to library
        </Button>
      </DialogActions>
    </Dialog>
  )
}
