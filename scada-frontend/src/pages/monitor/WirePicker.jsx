import { useState } from 'react'
import { WIRE_GROUPED, WireSample, wireType } from '@/components/mimic/wireTypes'
import styles from './WirePicker.module.css'

/**
 * WirePicker — the pen. Which line the next wire will be drawn in.
 *
 * It sits above the rail and stays there for the whole edit session, because
 * it is state you are working *in*: without it, running a fuel branch meant
 * drawing four lines and correcting the type on each one afterwards.
 *
 * Every option is a real segment of the line, drawn by the same code the
 * canvas uses at the same stroke weights — so the swatch cannot drift from
 * what actually lands on the sheet, and a 7-unit HV line looks seven units
 * heavy next to a 1.4-unit data link. Collapsed it shows one row, the pen in
 * hand; opened it shows the rack, grouped by discipline.
 */
export default function WirePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const current = wireType(value)

  return (
    <section className={styles.picker}>
      <button
        type="button"
        className={styles.current}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.eyebrow}>Wire type</span>
        <span className={styles.currentSample}>
          <WireSample id={value} width={52} />
        </span>
        <span className={styles.currentLabel}>{current.label}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>▶</span>
      </button>

      {open && (
        <div className={styles.rack}>
          {WIRE_GROUPED.map((group) => (
            <div key={group.id} className={styles.group}>
              <div className={styles.groupName}>{group.label}</div>
              <div className={styles.grid} role="radiogroup" aria-label={`${group.label} wire types`}>
                {group.ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={value === id}
                    className={`${styles.option} ${value === id ? styles.optionOn : ''}`}
                    onClick={() => { onChange(id); setOpen(false) }}
                  >
                    <span className={styles.optionSample}>
                      <WireSample id={id} width={56} height={14} />
                    </span>
                    <span className={styles.optionLabel}>{wireType(id).label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className={styles.hint}>
        Drag from any port dot to run a wire. New wires use this type.
      </p>
    </section>
  )
}
