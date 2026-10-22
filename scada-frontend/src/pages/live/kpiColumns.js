/**
 * kpiColumns.js — what the block column pickers offer for a table.
 *
 * Every column of the table is listed, so nothing is hidden by guesswork: the
 * ones a block can read are selectable, and the rest say why not. Text columns
 * do something else — they name machines and pick rows (`filterChoices`).
 * Mirrors `bind_picked` / `bind_families` in kpi_options.py.
 */

// [describe key, group label]
const GROUPS = [
  ['value_columns', 'Numbers'],
  ['array_value_columns', 'Arrays'],
  ['bool_columns', 'Flags'],
  ['text_columns', 'Text'],
  ['ts_columns', 'Time'],
]

/** [{name, badge, group}] for every column of a /schema/columns answer. */
export function columnChoices(cols) {
  const types = cols?.column_types || {}
  const seen = new Set()
  const out = []
  for (const [key, group] of GROUPS) {
    for (const name of cols?.[key] || []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, badge: types[name] || '', group })
    }
  }
  for (const name of Object.keys(types)) {
    if (!seen.has(name)) out.push({ name, badge: types[name], group: 'Other' })
  }
  return out
}

/**
 * Whether a column can be used as `use`: "number" is a measurement the machine
 * blocks integrate over time (a number or numeric array); "count" is anything a
 * defect tally can add up, which also takes flags (counted as 0 or 1).
 */
export function usableAs(choice, use = 'number') {
  if (choice.group === 'Numbers' || choice.group === 'Arrays') return true
  return use === 'count' && choice.group === 'Flags'
}

/** Why a column cannot be used — shown beside it. */
export function whyNotUsable(choice) {
  if (choice.group === 'Text') return 'Use it to name machines or pick rows'
  if (choice.group === 'Time') return 'A clock, not a count'
  return 'Not a number'
}

/** True when any picked column is an array, so the array rule matters. */
export function picksArray(choices, picked) {
  const arrays = new Set(choices.filter((c) => c.group === 'Arrays').map((c) => c.name))
  return (picked || []).some((n) => arrays.has(n))
}

/** Columns that can name machines or pick rows: text, flags and ids — never a clock or a measurement. */
export function filterChoices(cols) {
  const clocks = new Set(cols?.ts_columns || [])
  return (cols?.filter_columns || []).filter((c) => !clocks.has(c))
}

/** The numeric columns, for choosing sensors on a table with no machine columns. */
export function numericColumns(cols) {
  return [...(cols?.value_columns || []), ...(cols?.array_value_columns || [])]
}
