import { resolveReadingLabel } from '../../utils/defectLabels.js'

const EMPTY_LABELS = new Map()

/** Detect reading families from the selected table's actual column names.
 * A named base wins over an inferred prefix. Otherwise require two siblings
 * separated by a hyphen; shared letters alone are not a device identity.
 * Raw column names remain the values sent to the API and stored in URLs —
 * `labelsByCode` (code -> defect_labels[]) only swaps what is *displayed* for
 * a `defect_n` suffix when the group's key matches a configured camera.
 */
export function groupReadings(columns = [], labelsByCode = EMPTY_LABELS) {
  const names = [...new Set(columns)]
  const known = new Set(names)
  const inferred = new Map()
  const parent = (name) => {
    const split = name.lastIndexOf('-')
    return split > 0 && split < name.length - 1 ? name.slice(0, split) : ''
  }
  for (const name of names) {
    const prefix = parent(name)
    if (prefix) inferred.set(prefix, (inferred.get(prefix) ?? 0) + 1)
  }
  const familyFor = (name) => {
    let prefix = parent(name)
    while (prefix) {
      if (known.has(prefix)) return prefix
      prefix = parent(prefix)
    }
    const siblingPrefix = parent(name)
    return inferred.get(siblingPrefix) > 1 ? siblingPrefix : ''
  }
  // A base with descendants belongs to its own family, even if its name also
  // shares a prefix with other base columns (CAM001-13 and CAM001-14).
  const bases = new Set(names.map(familyFor).filter((name) => known.has(name)))
  const buckets = new Map()
  for (const value of names) {
    const key = bases.has(value) ? value : familyFor(value)
    if (!buckets.has(key)) buckets.set(key, { key, label: key || 'Other readings', options: [] })
    buckets.get(key).options.push({
      value,
      label: key
        ? (value === key ? 'Base reading' : resolveReadingLabel(key, value.slice(key.length + 1), labelsByCode))
        : value,
    })
  }
  return [...buckets.values()]
}

export function readingTitle(groups, value) {
  const group = groups.find((item) => item.options.some((option) => option.value === value))
  const option = group?.options.find((item) => item.value === value)
  return group?.key && value !== group.key ? `${group.label} · ${option.label}` : value
}
