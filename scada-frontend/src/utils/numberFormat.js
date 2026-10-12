/**
 * A number with thousands separators (123456789 → "123,456,789").
 *
 * Pinned to en-US so a plant PC's regional settings can't swap the separators
 * for something an operator reads differently.
 *
 * `decimals` fixes the fraction digits; `null`/`undefined` means "as-is" — the
 * number keeps whatever fraction it has, only gaining separators.
 */
export function groupDigits(n, decimals) {
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  return num.toLocaleString('en-US', decimals == null
    ? { maximumFractionDigits: 20, useGrouping: true }
    : { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true })
}

/** True when `v` is a finite number (or numeric string) that groupDigits can group. */
export function isDigits(v) {
  if (v == null || v === '' || typeof v === 'boolean') return false
  return Number.isFinite(Number(v))
}
