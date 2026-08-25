import { useMemo } from 'react'
import { compileCondition, testCondition } from '@/utils/mathExpr'

/**
 * Conditions authored on a symbol — the shared half of "light this lamp when…"
 * and "raise this tile when…".
 *
 * Both live here rather than in each symbol because the *rule* is the shared
 * part: a condition an admin typed is untrusted text that has to be compiled,
 * may be wrong, and must fail in one predictable direction. Duplicating that
 * into two symbols would be two chances to pick a different failure.
 *
 * Compilation is memoised on the string. Without it every symbol would re-parse
 * its conditions on every poll — at a 100ms cadence, on a sheet of lamps, that
 * is a parser running thousands of times a second to produce the same closures.
 */

/** How many colour cases one symbol may carry. */
export const MAX_CASES = 5

/**
 * The first case whose condition holds, or null.
 *
 * First-match-wins, not most-severe-wins: the cases are an ordered list the
 * admin wrote, and re-ranking them would mean a lamp ignoring the order it was
 * configured in. It also makes overlapping ranges usable — `a > 90` above
 * `a > 80` reads exactly as it looks.
 *
 * Returns the case *and* its index, so a caller can tell "matched the first
 * case" from "matched nothing" without comparing objects.
 */
export function useMatchedCase(cases, value) {
  const compiled = useMemo(() => (
    (Array.isArray(cases) ? cases : [])
      .slice(0, MAX_CASES)
      .map((c) => ({ ...c, fn: compileCondition(c?.when).fn }))
  ), [cases])

  return useMemo(() => {
    const i = compiled.findIndex((c) => testCondition(c.fn, value))
    return i === -1 ? null : { ...compiled[i], index: i }
  }, [compiled, value])
}

/**
 * Whether one condition holds for this reading.
 *
 * `null` rather than `false` when there is no condition at all, because "the
 * admin wrote no rule" and "the rule is not met" are different answers and the
 * caller has to fall back differently for each.
 */
export function useConditionMet(when, value) {
  const fn = useMemo(() => compileCondition(when).fn, [when])
  return fn == null ? null : testCondition(fn, value)
}
