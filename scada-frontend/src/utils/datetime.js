/**
 * Timestamp formatting shared by the card/tile layouts.
 *
 * Cards are laid out on a `minmax(212px, 1fr)` / `minmax(240px, 1fr)` grid, so
 * the narrowest column leaves roughly 200px of content width — less than a full
 * locale datetime plus anything sitting beside it. Timelines and tooltips have
 * the room and keep using the full form; tiles use the compact one.
 */

/** Full precision. Use where there is room: timelines, tooltips, detail rows. */
export function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

/**
 * Tile-sized stamp: a clock for today, a date for anything older.
 *
 * Dropping the date outright would be shorter still, but it would render last
 * week's event as this morning's — and an alarm that has been standing for days
 * is exactly the one an operator must not misread as fresh.
 */
export function fmtStamp(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
