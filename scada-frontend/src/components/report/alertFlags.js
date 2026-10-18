/**
 * Alert markers on the signal trend — the arithmetic, kept apart from React and
 * ECharts so it can be tested (alertFlags.test.js).
 *
 * A message is a moment, not a reading: it is drawn as a flag on a row along
 * the bottom of the plot, not as a point on the trace. Flags closer together
 * than a fingertip merge into one with a count, so a week-long window with a
 * busy shift reads as "a lot happened here" instead of a smear of overlapping
 * marks; zooming in pulls them apart again.
 */

/** Worst first, for a cluster's colour: one critical message makes it critical. */
export const SEVERITY_RANK = { info: 0, warn: 1, crit: 2 }

// Two flags nearer than this (px) are one cluster.
export const CLUSTER_GAP_PX = 14
// The pointer this near a message (px) counts as being on it, for the tooltip.
export const HOVER_PX = 8

/** API rows → `{ t, message, severity, severityRaw }`, oldest first. */
export function normalizeMessages(rows) {
  return (rows ?? [])
    .map((m) => ({
      t: Date.parse(m.ts),
      // Plant text is often multi-line, and SCADA writers use a bare CR (alarm_logs
      // joins its lines with two) - which a browser renders as a space.
      message: String(m.message ?? '').replace(/\r\n?/g, '\n').trim(),
      severity: SEVERITY_RANK[m.severity] != null ? m.severity : 'info',
      severityRaw: m.severity_raw ?? null,
      role: m.role ?? null,
    }))
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t)
}

const worst = (a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a)

/**
 * The flags on screen for `view` ({ from, to }, ms) on a plot `plotPx` wide.
 *
 * Each: `{ key, frac, from, to, count, severity, messages }` — `frac` is the
 * flag's place across the plot (0..1), `from`/`to` the times of its first and
 * last message (what a pinned box is held by while the view moves), and
 * `messages` newest first. Messages outside the view are not drawn.
 */
export function clusterMessages(messages, view, plotPx, gapPx = CLUSTER_GAP_PX) {
  const span = view.to - view.from
  if (!(span > 0) || !(plotPx > 0)) return []
  const out = []
  let cur = null
  for (const m of messages) {
    if (m.t < view.from || m.t > view.to) continue
    const px = ((m.t - view.from) / span) * plotPx
    // Measured from the cluster's *first* flag, not its last: a steady stream
    // (a check every 10 s is a few px apart) would otherwise chain into one
    // flag spanning the whole plot. Capped, a dense stretch reads as a row of
    // counted flags, each no wider than a fingertip.
    if (cur && px - cur.firstPx < gapPx) {
      cur.lastPx = px
      cur.to = m.t
      cur.severity = worst(cur.severity, m.severity)
      cur.messages.push(m)
    } else {
      cur = { firstPx: px, lastPx: px, from: m.t, to: m.t, severity: m.severity, messages: [m] }
      out.push(cur)
    }
  }
  return out.map((c) => ({
    key: `${c.from}:${c.messages.length}`,
    frac: (c.firstPx + c.lastPx) / 2 / plotPx,
    from: c.from,
    to: c.to,
    count: c.messages.length,
    severity: c.severity,
    messages: [...c.messages].reverse(),
  }))
}

/** Messages within `toleranceMs` of time `t`, newest first — the tooltip's list. */
export function messagesNear(messages, t, toleranceMs) {
  if (!Number.isFinite(t)) return []
  return messages.filter((m) => Math.abs(m.t - t) <= toleranceMs).reverse()
}

/** Messages held by a pinned box: those between its first and last time. */
export function messagesBetween(messages, from, to) {
  return messages.filter((m) => m.t >= from && m.t <= to).reverse()
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Text safe to put in tooltip HTML. Messages are written by the plant, not by
 * this app, and ECharts renders a formatter's string as markup — so every one
 * passes through here.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])
}
