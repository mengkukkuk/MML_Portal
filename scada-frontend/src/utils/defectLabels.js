/**
 * Maps a camera's `defect_n` reading/tag suffix to the human-readable label an
 * operator configured for that slot in the `cameras.defect_labels` array
 * (fetched via GET /api/cameras/link-options, scoped to whichever datasource
 * is designated the camera source in Settings). A slot left at its default
 * (`null`/empty) falls back to the raw `defect_n` name unchanged.
 */
const DEFECT_SUFFIX_RE = /^defect_(\d+)$/i

/** code -> defect_labels[] (1-indexed by defect_n, so slot n is index n-1). */
export function buildDefectLabelsByCode(cameras = []) {
  const map = new Map()
  for (const camera of cameras) {
    if (camera?.code) map.set(camera.code, camera.defect_labels ?? [])
  }
  return map
}

function labelForDefectSuffix(code, suffix, labelsByCode) {
  const match = DEFECT_SUFFIX_RE.exec(suffix ?? '')
  if (!match || !code) return null
  const labels = labelsByCode?.get(code)
  if (!labels) return null
  const label = labels[Number(match[1]) - 1]
  return label || null
}

/** Reports: `code` is the reading-group key, `suffix` the raw option name. */
export function resolveReadingLabel(code, suffix, labelsByCode) {
  return labelForDefectSuffix(code, suffix, labelsByCode) ?? suffix
}

/**
 * Events/Alarms: a camera's `tag_name` shows up two different ways depending
 * on how the plant's own table names its columns — a bare `defect_n` paired
 * with a `location` that names the camera, or a compound `CODE-defect_n` tag
 * carrying the code itself. Try both shapes rather than assuming one.
 */
export function resolveTagLabel(tagName, location, labelsByCode) {
  if (!tagName || !labelsByCode?.size) return tagName

  const direct = labelForDefectSuffix(location, tagName, labelsByCode)
  if (direct) return direct

  const split = tagName.lastIndexOf('-')
  if (split > 0 && split < tagName.length - 1) {
    const prefix = tagName.slice(0, split)
    const suffix = tagName.slice(split + 1)
    const label = labelForDefectSuffix(prefix, suffix, labelsByCode)
    if (label) return `${prefix}-${label}`
  }

  return tagName
}
