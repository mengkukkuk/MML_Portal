/** Detect name families among a flat list of raw names (tag/column names).
 * A name whose parent (everything before its last '-') is itself present in
 * `names` belongs to that parent's family (a "named base" — e.g. "CAM001-13"
 * is both a column and the shared prefix of "CAM001-13-count_1", etc).
 * Otherwise a shared hyphen-prefix needs >= 2 siblings before it counts as a
 * family: two names simply sharing letters is not a device identity.
 * Ungrouped names collect under key '' so callers can render them flat.
 */
export function groupByFamily(names = []) {
  const list = [...new Set(names)]
  const known = new Set(list)
  const inferred = new Map()
  const parent = (name) => {
    const split = name.lastIndexOf('-')
    return split > 0 && split < name.length - 1 ? name.slice(0, split) : ''
  }
  for (const name of list) {
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
  const bases = new Set(list.map(familyFor).filter((name) => known.has(name)))
  const buckets = new Map()
  for (const name of list) {
    const key = bases.has(name) ? name : familyFor(name)
    if (!buckets.has(key)) buckets.set(key, { key, names: [] })
    buckets.get(key).names.push(name)
  }
  return [...buckets.values()]
}
