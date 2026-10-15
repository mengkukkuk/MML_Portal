import { useEffect, useState } from 'react'
import { appendNoticeLog, noticeSignature, noticeText } from '../noticeBox'

/**
 * The last few messages each attention box has shown since the page loaded,
 * newest first, as `{ [boxId]: [{ text, ts }] }`.
 *
 * The poller only ever answers "what is the newest row", so the history is
 * kept here, a reading at a time. It is a view of this session, not of the
 * table: a reload starts it over with whatever is current.
 *
 * A reading is logged by its text and row time, never by its tag status: the
 * poller calls any row older than a few polls "stale", and a message written an
 * hour ago is still the current message, not a fault. A poll that returns the
 * same row again is deduplicated by `appendNoticeLog`.
 *
 * A box's log is dropped whenever its binding signature changes — messages from
 * the column an admin just unbound belong to a different stream. `carried` is
 * the reading on screen at that moment: until the re-keyed poll lands, the
 * poller keeps serving the *old* binding's reading under the same id
 * (keepPreviousData), and logging it would seed the new stream's history with
 * a message it never said.
 */
function readingsOf(notices, tags) {
  return notices.map((n) => ({
    id: n.id,
    signature: noticeSignature(n),
    text: noticeText(tags[n.id]),
    ts: tags[n.id]?.ts ?? null,
  }))
}

/** State for this set of boxes: unchanged entries kept, rebound ones reset. */
function reconcile(state, readings) {
  let changed = Object.keys(state).length !== readings.length
  const next = {}
  readings.forEach((r) => {
    const entry = state[r.id]
    if (entry && entry.signature === r.signature) {
      next[r.id] = entry
      return
    }
    changed = true
    next[r.id] = {
      signature: r.signature,
      log: [],
      carried: entry && r.text ? { text: r.text, ts: r.ts } : null,
    }
  })
  return changed ? next : state
}

export default function useNoticeLogs(notices, tags) {
  const readings = readingsOf(notices, tags)
  const [state, setState] = useState(() => reconcile({}, readings))

  // Reconciled during render rather than in an effect, so a rebound or removed
  // box never paints one frame of the previous stream's messages.
  const current = reconcile(state, readings)
  if (current !== state) setState(current)

  const key = readings.map((r) => [r.id, r.signature, r.text, r.ts].join('\u0002')).join('\u0003')
  useEffect(() => {
    setState((s) => {
      let changed = false
      const next = { ...s }
      readings.forEach((r) => {
        const entry = s[r.id]
        if (!entry || entry.signature !== r.signature || !r.text) return
        if (entry.carried && entry.carried.text === r.text && entry.carried.ts === r.ts) return
        const log = appendNoticeLog(entry.log, { text: r.text, ts: r.ts })
        if (log === entry.log && !entry.carried) return
        next[r.id] = { signature: entry.signature, log, carried: null }
        changed = true
      })
      return changed ? next : s
    })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- `key` is `readings`, flattened

  const logs = {}
  Object.entries(current).forEach(([id, entry]) => { logs[id] = entry.log })
  return logs
}
