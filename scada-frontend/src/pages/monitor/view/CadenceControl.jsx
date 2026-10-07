import styles from '../MonitorPage.module.css'

/**
 * How often the drawing asks for new numbers.
 *
 * Unlike /live panels — whose interval is stored per panel and checked against
 * `VALID_POLL_INTERVALS` in panels.py — the mimic reads through /api/schema and
 * nothing on the server bounds its rate. The floor below is ours to hold.
 */
const CADENCES = [
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
]

/**
 * Behind the guard. Every poll opens a fresh libpq connection per binding
 * (`_table_source_conn`, no pool), so ten reads a second across a drawing of
 * thirty symbols is three hundred connections a second at the historian. It is
 * the right rate for commissioning one loop and the wrong one to leave running.
 */
const FAST_CADENCES = [
  { ms: 500, label: '500ms' },
  { ms: 100, label: '100ms' },
]

/** Where closing the guard puts you back. */
const GUARDED_FLOOR_MS = 1000

const CADENCE_NOTE_ID = 'mimic-cadence-note'

/**
 * The poll-rate selector with its guarded sub-second rates.
 *
 * `fastOpen` is owned by the page, not here: the overview folds this control
 * away, and an open guard must survive that.
 */
export default function CadenceControl({
  intervalMs, onInterval, fastOpen, onFastOpen,
}) {
  const fastActive = FAST_CADENCES.some((c) => c.ms === intervalMs)
  // A rate in use is never hidden: closing the cover over the button you are
  // standing on would leave the strip claiming a rate nothing on it shows.
  const fastShown = fastOpen || fastActive

  const cadenceBtn = (c, fast) => (
    <button
      key={c.ms}
      type="button"
      className={[
        styles.cadenceBtn,
        fast ? styles.cadenceFast : '',
        intervalMs === c.ms ? styles.cadenceOn : '',
      ].filter(Boolean).join(' ')}
      aria-pressed={intervalMs === c.ms}
      onClick={() => onInterval(c.ms)}
    >
      {c.label}
    </button>
  )

  return (
    <div className={styles.cadenceWrap}>
      <div
        className={`${styles.cadence} ${fastActive ? styles.cadenceElevated : ''}`}
        role="group"
        aria-label="Poll interval"
      >
        {CADENCES.map((c) => cadenceBtn(c, false))}
        {fastShown && FAST_CADENCES.map((c) => cadenceBtn(c, true))}
        <button
          type="button"
          className={styles.cadenceGuard}
          aria-expanded={fastShown}
          aria-controls={CADENCE_NOTE_ID}
          title={fastActive
            ? `Return to ${GUARDED_FLOOR_MS / 1000}s and close`
            : fastOpen ? 'Close sub-second rates' : 'Open sub-second rates'}
          onClick={() => {
            // Closing the cover puts the rate back, the way a guarded switch
            // springs shut. Leaving a plant on 100ms because a panel was tidied
            // away is exactly the outcome the guard exists to prevent.
            if (fastActive) onInterval(GUARDED_FLOOR_MS)
            onFastOpen(!fastShown)
          }}
        >
          {fastShown ? '«' : '»'}
        </button>
      </div>

      {/* Anchored, so opening the guard cannot shove the page header taller. */}
      {fastShown && (
        <p className={styles.cadenceNote} id={CADENCE_NOTE_ID} role="note">
          Each poll opens one database connection per bound symbol. Use sub-second
          rates to commission a loop, then step back down.
        </p>
      )}
    </div>
  )
}
