/**
 * kpiColumns.js — what the Loss meter's column pickers offer for a table.
 *
 * Every column of the table is listed, so nothing is hidden by guesswork: the
 * ones a defect count can read (numbers, numeric arrays, flags) are selectable,
 * and the rest say why not. Text columns do something else — they pick which
 * rows count (`filterChoices`). Mirrors `bind_picked` in kpi_options.py.
 */

// [describe key, group label, can be counted]
const GROUPS = [
  ['value_columns', 'Numbers', true],
  ['array_value_columns', 'Arrays', true],
  ['bool_columns', 'Flags', true],
  ['text_columns', 'Text', false],
  ['ts_columns', 'Time', false],
]

/** [{name, badge, group, countable}] for every column of a /schema/columns answer. */
export function columnChoices(cols) {
  const types = cols?.column_types || {}
  const seen = new Set()
  const out = []
  for (const [key, group, countable] of GROUPS) {
    for (const name of cols?.[key] || []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, badge: types[name] || '', group, countable })
    }
  }
  for (const name of Object.keys(types)) {
    if (!seen.has(name)) out.push({ name, badge: types[name], group: 'Other', countable: false })
  }
  return out
}

/** Why a column cannot be counted — shown beside it, '' when it can. */
export function whyNotCounted(choice) {
  if (choice.countable) return ''
  if (choice.group === 'Text') return 'Use it to pick rows below'
  if (choice.group === 'Time') return 'A clock, not a count'
  return 'Not a number'
}

/** True when any picked column is an array, so the array rule matters. */
export function picksArray(choices, picked) {
  const arrays = new Set(choices.filter((c) => c.group === 'Arrays').map((c) => c.name))
  return (picked || []).some((n) => arrays.has(n))
}

/** Columns that can pick rows: text, flags and ids — never a clock or a measurement. */
export function filterChoices(cols) {
  const clocks = new Set(cols?.ts_columns || [])
  return (cols?.filter_columns || []).filter((c) => !clocks.has(c))
}
