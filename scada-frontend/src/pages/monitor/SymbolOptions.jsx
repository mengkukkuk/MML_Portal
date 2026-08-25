import { useState } from 'react'
import AddOutlined from '@mui/icons-material/AddOutlined'
import CloseOutlined from '@mui/icons-material/CloseOutlined'
import { LED_PALETTE } from '@/components/mimic/symbols/Led'
import { MARQUEE_SPEEDS } from '@/components/mimic/symbols/DisplayBox'
import { MAX_CASES } from '@/components/mimic/conditions'
import { compileCondition } from '@/utils/mathExpr'
import styles from './SymbolOptions.module.css'

/**
 * New rules are pre-coloured red, then green, then amber — the order an
 * engineer describes a lamp in, and the order that makes the common
 * three-rule case need no visits to the palette at all.
 */
const NEW_CASE_COLORS = ['#ff3b30', '#34c759', '#ffcc00', '#32ade6', '#af52de']

/**
 * A condition field with its parse error underneath.
 *
 * The pair is wrapped rather than returned as a fragment, and that wrapper is
 * load-bearing: in the rule row the field's siblings are laid out in a flex
 * row, so a bare fragment made the message a *third* item in that row and the
 * input gave up its width to it — the box collapsed as soon as the half-typed
 * condition became invalid, which is every keystroke but the last.
 */
function ConditionInput({ value, placeholder, onChange }) {
  const error = value ? compileCondition(value).error : ''
  return (
    <div className={styles.condWrap}>
      <input
        className={`${styles.cond} ${error ? styles.condBad : ''}`}
        value={value ?? ''}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}

/**
 * The honeycomb lens palette.
 *
 * Hexagonal because the colours are a *wheel*, and a square grid draws a wheel
 * as a table: in a grid every swatch has four neighbours and the two on the
 * diagonal are lies, so "one step warmer" is not a direction you can move. In a
 * honeycomb each swatch touches six others and the hue genuinely runs around
 * the ring, which is the only reason to prefer it here — it is a better map of
 * the thing being chosen, not a nicer shape.
 */
function Honeycomb({ value, onPick }) {
  return (
    <div className={styles.comb} role="listbox" aria-label="Lens colour">
      {LED_PALETTE.map((row) => (
        <div className={styles.combRow} key={row.join()}>
          {row.map((hex) => (
            <button
              key={hex}
              type="button"
              role="option"
              aria-selected={value === hex}
              aria-label={hex}
              title={hex}
              className={`${styles.cell} ${value === hex ? styles.cellOn : ''}`}
              style={{ background: hex }}
              onClick={() => onPick(hex)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Up to five `{ when, color }` rules, first match winning. */
function ColourCases({ cases, onChange }) {
  const [openAt, setOpenAt] = useState(null)
  const list = Array.isArray(cases) ? cases : []

  const patch = (i, next) => onChange(list.map((c, j) => (j === i ? { ...c, ...next } : c)))

  return (
    <>
      <p className={styles.hint}>
        The first rule that holds picks the colour. Anything below a rule that is
        already true never runs, so put the most serious one at the top. With no
        rules the lamp is coloured by its limits, as before. A rule can test a
        number (<code>value &gt; 80</code>) or a word
        (<code>value == &apos;FAULT&apos;</code>).
      </p>

      <ol className={styles.cases}>
        {list.map((c, i) => (
          // The index is the key, which is usually a mistake and here is not:
          // position *is* this list's identity — rule 2 means "the second thing
          // tried". Both fields are controlled, so a removal re-renders the
          // reused row from the new data rather than stranding the old text.
          <li className={styles.case} key={i}>
            <div className={styles.caseRow}>
              <button
                type="button"
                className={styles.swatch}
                style={{ background: c.color }}
                aria-label={`Colour for rule ${i + 1}`}
                aria-expanded={openAt === i}
                onClick={() => setOpenAt(openAt === i ? null : i)}
              />
              <ConditionInput
                value={c.when}
                placeholder="value > 80"
                onChange={(when) => patch(i, { when })}
              />
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove rule ${i + 1}`}
                onClick={() => {
                  setOpenAt(null)
                  onChange(list.filter((_, j) => j !== i))
                }}
              >
                <CloseOutlined fontSize="inherit" />
              </button>
            </div>

            {openAt === i && (
              <Honeycomb value={c.color} onPick={(color) => patch(i, { color })} />
            )}
          </li>
        ))}
      </ol>

      <button
        type="button"
        className={styles.add}
        disabled={list.length >= MAX_CASES}
        onClick={() => onChange([
          ...list,
          { when: '', color: NEW_CASE_COLORS[list.length] ?? NEW_CASE_COLORS[0] },
        ])}
      >
        <AddOutlined fontSize="small" />
        {list.length >= MAX_CASES ? `${MAX_CASES} rules is the limit` : 'Add colour rule'}
      </button>
    </>
  )
}

/**
 * SymbolOptions — the per-symbol appearance controls on the inspector rail.
 *
 * Separate from SymbolBindingDialog because the split is real: the dialog says
 * *which column* this symbol reads, and these say *how it draws what it read*.
 * Only the first can fail to save, needs a schema round trip, or invalidates the
 * preview — and only the second is something you want to fiddle with while
 * watching the drawing, which is where the rail already is.
 *
 * Returns null for a symbol with nothing to configure, so the rail shows no
 * empty section for the great majority of types that have no options at all.
 * Adding options to a new symbol means one more branch here and one more key in
 * `node.options`; the server stores the bag untouched, so neither needs a
 * backend change.
 */
export default function SymbolOptions({ node, onChange }) {
  const o = node.options ?? {}

  if (node.type === 'displaybox') {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Moving text</div>
        <p className={styles.hint}>
          A still box shrinks long text to fit. A moving one keeps it full size
          and scrolls instead — worth it for a legend that has outgrown the box,
          not for a number.
        </p>
        <label className={styles.field}>
          <span>Scroll</span>
          <select
            value={o.marquee ?? 'off'}
            onChange={(e) => onChange({ marquee: e.target.value })}
          >
            <option value="off">Off — shrink to fit</option>
            {Object.keys(MARQUEE_SPEEDS).map((k) => (
              <option key={k} value={k}>
                {k[0].toUpperCase() + k.slice(1)} — {MARQUEE_SPEEDS[k]} units/s
              </option>
            ))}
          </select>
        </label>
      </div>
    )
  }

  if (node.type === 'led') {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Colour rules</div>
        <ColourCases cases={o.cases} onChange={(cases) => onChange({ cases })} />
      </div>
    )
  }

  if (node.type === 'alertbadge') {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Alarm condition</div>
        <p className={styles.hint}>
          Leave this empty and the tile follows the warn and critical limits set
          on its data source. Fill it in and the expression takes over
          completely — one tile answers one question.
        </p>
        <label className={styles.field}>
          <span>Raise when</span>
          <ConditionInput
            value={o.when}
            placeholder="value > 80"
            onChange={(when) => onChange({ when })}
          />
        </label>
        <label className={styles.field}>
          <span>Severity</span>
          <select
            value={o.severity ?? 'critical'}
            disabled={!o.when}
            onChange={(e) => onChange({ severity: e.target.value })}
          >
            <option value="critical">Critical — red, flashing</option>
            <option value="warning">Warning — amber, steady</option>
          </select>
        </label>
        <p className={styles.hint}>
          Compare with <code>&gt; &lt; &gt;= &lt;= == !=</code>, join with{' '}
          <code>and</code> / <code>or</code> / <code>not</code>. <code>value</code> is the
          reading after its expression has been applied. On a text column compare
          against a quoted word — <code>value == &apos;FAULT&apos;</code> — which
          ignores case and surrounding spaces.
        </p>
      </div>
    )
  }

  return null
}
