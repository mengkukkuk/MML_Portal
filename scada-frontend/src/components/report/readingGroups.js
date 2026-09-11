import { groupByFamily } from '../../utils/nameFamilies.js'
import { resolveReadingLabel } from '../../utils/defectLabels.js'

const EMPTY_LABELS = new Map()

/** Detect reading families from the selected table's actual column names,
 * via the shared `groupByFamily` (a named base wins over an inferred
 * prefix; otherwise two siblings sharing a hyphen prefix are required —
 * shared letters alone are not a device identity). Raw column names remain
 * the values sent to the API and stored in URLs — `labelsByCode`
 * (code -> defect_labels[]) only swaps what is *displayed* for a `defect_n`
 * suffix when the group's key matches a configured camera.
 */
export function groupReadings(columns = [], labelsByCode = EMPTY_LABELS) {
  return groupByFamily(columns).map(({ key, names }) => ({
    key,
    label: key || 'Other readings',
    options: names.map((value) => ({
      value,
      label: key
        ? (value === key ? 'Base reading' : resolveReadingLabel(key, value.slice(key.length + 1), labelsByCode))
        : value,
    })),
  }))
}

export function readingTitle(groups, value) {
  const group = groups.find((item) => item.options.some((option) => option.value === value))
  const option = group?.options.find((item) => item.value === value)
  return group?.key && value !== group.key ? `${group.label} · ${option.label}` : value
}
