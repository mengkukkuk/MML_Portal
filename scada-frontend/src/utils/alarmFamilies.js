import { groupByFamily } from './nameFamilies.js'

/**
 * Aggregation behind the family-collapsed views on Alarms and Events.
 *
 * Both pages render a tag-name family (e.g. CAM001-13) as one collapsed
 * summary that opens to reveal its members. Everything that decides *what the
 * summary says* and *where it sits* lives here rather than in a component
 * useMemo, because none of it is verifiable by eye — a mis-ranked tile still
 * looks perfectly plausible — and the frontend has no DOM test runner.
 *
 * Two rules are worth spelling out:
 *
 * 1. Family membership is inferred from `knownNames` (a stable superset —
 *    typically the recent-log tag names) unioned with the names actually
 *    present, not from the present names alone. groupByFamily only infers a
 *    family when a prefix has >= 2 members, so feeding it just the live rows
 *    makes a family dissolve the moment it drops to one active alarm: the
 *    Alarms page repolls every second, so an operator reading CAM001-13 would
 *    watch the card evaporate as its siblings cleared. Membership comes from
 *    the superset; contents come from the rows.
 *
 * 2. Names with no family are returned as their own single-member entries
 *    (isGroup false) rather than pooled in groupByFamily's '' bucket, so a
 *    caller can render one uniform tile per entry instead of special-casing
 *    a mixed bucket of unrelated tags.
 */

export const SEV_RANK = { critical: 3, warning: 2, info: 1 }

export function sevRank(severity) {
  return SEV_RANK[severity] ?? 0
}

export function worstSeverity(severities = []) {
  let worst = 'info'
  for (const severity of severities) {
    if (sevRank(severity) > sevRank(worst)) worst = severity
  }
  return worst
}

function latestOf(a, b) {
  if (!a) return b
  if (!b) return a
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  if (Number.isNaN(tb)) return a
  if (Number.isNaN(ta)) return b
  return tb > ta ? b : a
}

/** Severity first — it is the only ranking an alarm operator scans for — then
 * name, so tiles only ever move when a severity genuinely changes rather than
 * reshuffling on every poll. Numeric collation keeps CAM002 above CAM010. */
export function compareBySeverityThenName(a, b) {
  const bySeverity = sevRank(b.severity) - sevRank(a.severity)
  if (bySeverity !== 0) return bySeverity
  return String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
}

function aggregate(key, isGroup, members) {
  const sorted = [...members].sort(compareBySeverityThenName)
  let total = 0
  let unacked = 0
  let latest = null
  const names = new Set()
  for (const member of sorted) {
    total += member.count ?? 1
    unacked += member.unacked ?? 0
    latest = latestOf(latest, member.latest)
    names.add(member.name)
  }
  return {
    key,
    name: key,
    isGroup,
    severity: worstSeverity(sorted.map((m) => m.severity)),
    tagCount: names.size,
    total,
    unacked,
    latest,
    location: sorted[0]?.location ?? null,
    members: sorted,
  }
}

/**
 * @param items       [{ name, severity?, count?, unacked?, latest?, location?, ... }]
 *                    One entry per thing the caller would otherwise render:
 *                    an active alarm on the Alarms grid, a tag card in a log stack.
 * @param knownNames  Stable superset of tag names used only to decide family
 *                    membership (see note 1 above).
 * @param grouped     false bypasses grouping entirely — used when a specific
 *                    Tag filter is set, where wrapping the one requested tag in
 *                    a collapsed container would just second-guess the request.
 * @returns [{ key, name, isGroup, severity, tagCount, total, unacked, latest, location, members }]
 */
export function buildFamilies({ items = [], knownNames = [], grouped = true } = {}) {
  if (!grouped) {
    return items
      .map((item) => aggregate(item.name, false, [item]))
      .sort(compareBySeverityThenName)
  }

  const universe = [...new Set([...knownNames, ...items.map((item) => item.name)])]
  const keyByName = new Map()
  for (const family of groupByFamily(universe)) {
    for (const name of family.names) keyByName.set(name, family.key)
  }

  const groups = new Map()
  const singles = []
  for (const item of items) {
    const key = keyByName.get(item.name) || ''
    if (!key) {
      singles.push(item)
      continue
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  return [
    ...[...groups.entries()].map(([key, members]) => aggregate(key, true, members)),
    ...singles.map((item) => aggregate(item.name, false, [item])),
  ].sort(compareBySeverityThenName)
}
