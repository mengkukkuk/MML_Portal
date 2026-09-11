/**
 * One vocabulary for "what kind of column is this", shared by every picker.
 *
 * `/api/schema/columns` answers with a column *category* per list
 * (`value_columns`, `bool_columns`, `text_columns`, …) plus a `column_types`
 * map giving each column a short type token. Three editors ask that question —
 * the Live panel editor, the Monitor symbol binding dialog and the report
 * TrendRail — and each of them used to render a bare flat list of names. An
 * admin picking `enabled` could not tell it from `enabled_count` until after
 * the tile was saved and drew the wrong thing.
 *
 * Kept JSX-free so the two editors can render the same grouping in their own
 * widgets: Live in MUI, Monitor in native `<select>`, which cannot carry
 * markup inside an `<option>`.
 *
 * Every function degrades rather than throws. A server that predates
 * `column_types` yields empty badges, a missing list yields no group, and a
 * null envelope yields nothing at all — a picker mid-fetch renders empty, not
 * broken.
 */

import { groupByFamily } from './nameFamilies.js'

/** Group headings, keyed by the field of the columns envelope they read.
 *
 * The wording says what the column *is for*, not what type it is — the badge
 * already carries the type, and "Numeric" alone does not tell an admin why a
 * flag is filed separately from a counter.
 */
export const KIND_LABELS = {
  value_columns: 'Numeric — measured',
  bool_columns: 'Boolean — on/off',
  text_columns: 'Text — printed as written',
  array_value_columns: 'Array — several readings',
  ts_columns: 'Timestamp',
  datetime_columns: 'Timestamp',
  filter_columns: 'Any column',
}

/** What a flag prints until someone types better words. Index is the value:
 * [0] for false, [1] for true. Shared so the editor's placeholder and the
 * tile's fallback cannot drift apart -- when they did, the editor showed
 * OFF/ON and the tile drew 1.
 */
export const DEFAULT_BOOL_LABELS = ['OFF', 'ON']

/** The short type token for one column, or '' when the server didn't say. */
export function badgeFor(cols, name) {
  return cols?.column_types?.[name] ?? ''
}

/**
 * Ordered, grouped options for a column picker.
 *
 * `kinds` names the envelope fields to offer, in the order they should appear —
 * the first is the conventional default, so put the kind a picker most expects
 * first. Empty groups are dropped, but a group of one is still labelled: two
 * editors showing the same table must read alike, and a lone unlabelled option
 * is exactly the ambiguity this exists to remove.
 *
 * Returns `[{ key, label, options: [{ name, badge }] }]`.
 */
export function groupColumns(cols, kinds) {
  if (!cols) return []
  return kinds
    .map((key) => ({
      key,
      label: KIND_LABELS[key] ?? key,
      options: (cols[key] ?? []).map((name) => ({ name, badge: badgeFor(cols, name) })),
    }))
    .filter((g) => g.options.length > 0)
}

/** Every column name `groupColumns(cols, kinds)` would offer, flattened.
 *
 * The clamp counterpart to the render: "is the stored column still on offer"
 * has to be asked against exactly the list the picker draws, or a binding
 * silently survives in state while showing as unselected.
 */
export function pickableColumns(cols, kinds) {
  return kinds.flatMap((key) => cols?.[key] ?? [])
}

/**
 * Split one kind group's options into name families (e.g. every
 * `CAM001-13-count_n`/`CAM001-13-defect_n` option clustered under a
 * `CAM001-13` bucket), via the shared `groupByFamily`. Options with no
 * detected family land in a single `key: ''` bucket — a caller sees just one
 * bucket back when nothing groups, so it can fall back to rendering `options`
 * flat exactly as before this existed.
 *
 * Returns `[{ key, label, options: [{ name, badge }] }]`, the same option
 * shape as `groupColumns`, just re-bucketed by name instead of kind.
 */
export function familyGroups(options = []) {
  const byName = new Map(options.map((o) => [o.name, o]))
  return groupByFamily(options.map((o) => o.name)).map(({ key, names }) => ({
    key,
    label: key,
    options: names.map((name) => byName.get(name)),
  }))
}

/**
 * Narrow grouped options to those matching a search string.
 *
 * Matches the column name and, when given, its display label — not the badge:
 * typing "int" to mean the word in `print_head` and getting every integer
 * column back is worse than no search. `labelFor` lets a caller that renders
 * a mapped label (e.g. a camera's `defect_n` slot shown as its configured
 * name) be searched by that name too, without this module knowing anything
 * about where the mapping comes from. An empty or blank query returns the
 * groups untouched.
 */
export function filterGroups(groups, query, labelFor = (name) => name) {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  return groups
    .map((g) => ({
      ...g,
      options: g.options.filter(
        (o) => o.name.toLowerCase().includes(q) || labelFor(o.name).toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.options.length > 0)
}
