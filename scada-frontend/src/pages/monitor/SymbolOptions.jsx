import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import AddOutlined from '@mui/icons-material/AddOutlined'
import CloseOutlined from '@mui/icons-material/CloseOutlined'
import { LED_PALETTE } from '@/components/mimic/symbols/Led'
import { MARQUEE_SPEEDS } from '@/components/mimic/symbols/DisplayBox'
import {
  MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, TIME_FORMATS, tableColumns, tableRowLimit,
} from '@/components/mimic/symbols/DataTable'
import { MAX_CASES } from '@/components/mimic/conditions'
import { fetchMimicCameras } from '@/api/mimic'
import { fetchSchemaColumns } from '@/api/schema'
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
        number (<code>a &gt; 80</code>) or a word
        (<code>a == &apos;FAULT&apos;</code>) — on a coded column mapped to
        names, the word is what a rule compares against, not the code
        underneath it.
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
                placeholder="a > 80"
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

/** Alignment is inferred from the value's type unless an admin overrides it. */
const ALIGNS = [
  ['auto', 'Auto — numbers right'],
  ['left', 'Left'],
  ['right', 'Right'],
]

/**
 * The layout, drawn as the strip of proportions it actually is.
 *
 * Width weights are unreadable as a column of numbers — 1, 1, 2.5, 0.75 tells
 * you nothing about the table you are designing, because a width only means
 * anything relative to its neighbours. This is the same arithmetic the symbol
 * does, shown at the top of the editor, so the structure is visible while it is
 * being built rather than only after clicking back to the drawing.
 */
function ProportionBar({ columns }) {
  const weights = columns.map((c) => Math.max(0.25, Number(c.weight) || 1))
  const total = weights.reduce((a, b) => a + b, 0)
  return (
    <div className={styles.proportions} aria-hidden="true">
      {columns.map((c, i) => (
        <span
          key={`${c.col}-${i}`}
          className={styles.proportion}
          style={{ flexGrow: weights[i], flexBasis: 0 }}
          title={`${c.title || c.col} — ${Math.round((weights[i] / total) * 100)}%`}
        >
          {c.title || c.col}
        </span>
      ))}
    </div>
  )
}

/**
 * The table symbol's structure editor — which columns, in what order, how wide.
 *
 * The one symbol whose *shape* is configuration rather than a property of its
 * type, so this is the only options panel that edits a list of things rather
 * than a handful of switches. Order is left-to-right on the drawing, which is
 * why the reorder controls are ‹ and › rather than the up/down a vertical list
 * would suggest — the list runs down the rail, but the thing it describes runs
 * across the sheet.
 */
function TableStructure({ node, onChange }) {
  const binding = node.binding
  const columns = tableColumns(node)
  const rows = tableRowLimit(node)

  const catalogue = useQuery({
    queryKey: ['schema-columns', binding?.table, binding?.datasource_id ?? null],
    queryFn: () => fetchSchemaColumns(binding.table, binding.datasource_id ?? undefined),
    enabled: !!binding?.table,
    staleTime: 5 * 60_000,
  })

  // Every column of the bound table, in one list. The catalogue splits them by
  // what they are good for — plotting, printing, filtering — and a table cell
  // will happily draw any of them, so the split is not a distinction here.
  const available = useMemo(() => {
    const d = catalogue.data
    if (!d) return []
    return [...new Set([
      ...(d.value_columns ?? []), ...(d.text_columns ?? []),
      ...(d.ts_columns ?? []), ...(d.filter_columns ?? []),
    ])]
  }, [catalogue.data])

  // Which of them are stamps. A timestamp cell is formatted, not rounded, so
  // this decides which of the two third fields a column row gets — the one
  // question that has no sensible answer for the other kind of column.
  const stamps = useMemo(
    () => new Set(catalogue.data?.ts_columns ?? []),
    [catalogue.data],
  )

  if (!binding?.table) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Columns</div>
        <p className={styles.hint}>
          Connect a data source first. The table it points at is the one whose
          columns you choose from here.
        </p>
      </div>
    )
  }

  const commit = (next) => onChange({ columns: next })
  const patch = (i, fields) => commit(columns.map((c, j) => (j === i ? { ...c, ...fields } : c)))
  const move = (i, delta) => {
    const next = [...columns]
    const [moved] = next.splice(i, 1)
    next.splice(i + delta, 0, moved)
    commit(next)
  }

  const unused = available.filter((c) => !columns.some((chosen) => chosen.col === c))

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Columns</div>
        <p className={styles.hint}>
          Left to right, as they will be drawn. Width is a share of the symbol,
          not a pixel count, so the table keeps its proportions when it is
          resized on the sheet.
        </p>

        {columns.length > 0 && <ProportionBar columns={columns} />}

        <ol className={styles.cols}>
          {columns.map((c, i) => (
            // Position is identity here in the same way it is for colour rules:
            // "the third column" is what this row means, and every field on it
            // is controlled, so a removal redraws the reused row from new data.
            // eslint-disable-next-line react/no-array-index-key
            <li className={styles.col} key={i}>
              <div className={styles.colRow}>
                <select
                  className={styles.colPick}
                  value={c.col}
                  aria-label={`Column ${i + 1} source`}
                  onChange={(e) => patch(i, {
                    col: e.target.value,
                    // Switching a column onto or off a stamp switches what its
                    // third field means, so the value behind it has to follow.
                    format: stamps.has(e.target.value) ? (c.format ?? 'time') : null,
                  })}
                >
                  {/* A column the table no longer has still has to be shown, or
                      the select would silently re-point the symbol at whatever
                      happens to be first in the list. */}
                  {!available.includes(c.col) && (
                    <option value={c.col}>{c.col} (not in table)</option>
                  )}
                  {available.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.nudge}
                  disabled={i === 0}
                  aria-label={`Move ${c.title || c.col} left`}
                  onClick={() => move(i, -1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className={styles.nudge}
                  disabled={i === columns.length - 1}
                  aria-label={`Move ${c.title || c.col} right`}
                  onClick={() => move(i, 1)}
                >
                  ›
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove column ${i + 1}`}
                  onClick={() => commit(columns.filter((_, j) => j !== i))}
                >
                  <CloseOutlined fontSize="inherit" />
                </button>
              </div>

              <input
                className={styles.colTitle}
                value={c.title ?? ''}
                placeholder={c.col}
                aria-label={`Heading for ${c.col}`}
                onChange={(e) => patch(i, { title: e.target.value })}
              />

              <div className={styles.colGrid}>
                <label className={styles.field}>
                  <span>Align</span>
                  <select
                    value={c.align ?? 'auto'}
                    onChange={(e) => patch(i, { align: e.target.value })}
                  >
                    {ALIGNS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Width</span>
                  <input
                    className={styles.colNum}
                    type="number"
                    min="0.25"
                    max="6"
                    step="0.25"
                    value={c.weight ?? 1}
                    onChange={(e) => patch(i, { weight: Number(e.target.value) })}
                  />
                </label>
                {stamps.has(c.col) || c.format ? (
                  <label className={styles.field}>
                    <span>Time</span>
                    <select
                      value={c.format ?? 'time'}
                      onChange={(e) => patch(i, { format: e.target.value })}
                    >
                      {Object.entries(TIME_FORMATS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className={styles.field}>
                    <span>Decimals</span>
                    <select
                      value={c.decimals ?? ''}
                      onChange={(e) => patch(i, {
                        decimals: e.target.value === '' ? null : Number(e.target.value),
                      })}
                    >
                      <option value="">As stored</option>
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </li>
          ))}
        </ol>

        <button
          type="button"
          className={styles.add}
          disabled={columns.length >= MAX_TABLE_COLUMNS || unused.length === 0}
          onClick={() => commit([...columns, {
            col: unused[0],
            weight: 1,
            ...(stamps.has(unused[0]) ? { format: 'time' } : {}),
          }])}
        >
          <AddOutlined fontSize="small" />
          {columns.length >= MAX_TABLE_COLUMNS
            ? `${MAX_TABLE_COLUMNS} columns is the limit`
            : unused.length === 0
              ? catalogue.isPending ? 'Reading the table…' : 'Every column is already shown'
              : 'Add column'}
        </button>

        {catalogue.isError && (
          <p className={styles.error}>
            Could not read the columns of {binding.table}. The connection may be down.
          </p>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Rows</div>
        <p className={styles.hint}>
          {binding.ts_col
            ? `Newest first, by ${binding.ts_col} — the top row is the most recent, and on a clock column the date is written only where the day turns over.`
            : 'This binding has no time column, so rows arrive in the order the plant stores them. Set one in the connection to read it as a log, newest first.'}
          {' '}The symbol draws as many as fit and says so when it is showing
          fewer than it fetched.
        </p>
        <label className={styles.field}>
          <span>Fetch</span>
          <input
            className={styles.colNum}
            type="number"
            min="1"
            max={MAX_TABLE_ROWS}
            step="1"
            value={rows}
            onChange={(e) => onChange({ rows: Number(e.target.value) })}
          />
        </label>
      </div>
    </>
  )
}

/**
 * Which registered camera this symbol shows in the view-mode detail rail.
 *
 * The odd one out in this file — every other control here is appearance, and
 * this one is a link to a record. It lives here anyway because the alternative
 * is worse: SymbolBindingDialog's save path carries exactly `tagId`, `label`
 * and `binding`, and `binding` is validated server-side against a real plant
 * table, which a camera reference is not. `node.options` is the bag the server
 * already stores untouched, so this needs no backend change at all.
 *
 * Stores the camera's `code`, not its row id. The list comes from a table the
 * vision system owns, in whichever plant the header has selected — a row id
 * there is a per-database serial that means something different in the next
 * line's schema, while `CAM-03` is what is printed on the station.
 *
 * The list itself comes from this drawing's `doc.cameraDefect` binding, so it
 * is empty until an admin has configured one. That is deliberate: a global
 * camera list would have to guess which line a symbol belongs to.
 */
function CameraLink({ node, slug, onChange, onConfigure }) {
  // Same query key the rail uses, so this list is usually already warm.
  const { data: cameras, isLoading, error } = useQuery({
    queryKey: ['mimic-cameras', slug],
    queryFn: () => fetchMimicCameras(slug),
    enabled: !!slug,
    staleTime: 60_000,
    retry: false,
  })

  const unconfigured = error?.response?.status === 404
  const isError = !!error

  const linked = node.options?.cameraId ?? ''
  const loopId = node.tagId?.trim() || ''

  // A symbol bound the old way — loop id typed to match a code — pre-selects
  // the camera it already resolves to, so the first save here turns an implicit
  // match into an explicit link and the legacy path quietly loses its last user.
  const legacyMatch = useMemo(() => {
    if (linked || !loopId || !cameras) return null
    return cameras.find((c) => c.code.toLowerCase() === loopId.toLowerCase()) ?? null
  }, [cameras, linked, loopId])

  const value = linked || legacyMatch?.code || ''

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Camera</div>
      <p className={styles.hint}>
        {unconfigured
          ? 'This drawing has no camera table yet. Point it at the vision system’s defect table to fill the list below.'
          : isError
            ? 'The camera list could not be loaded. The rail falls back to matching this symbol’s loop id against a camera code.'
            : legacyMatch
              ? `This symbol currently resolves by loop id (${loopId}). Saving makes the link explicit.`
              : 'Picks which camera’s defect counts and inspection frames fill the detail panel in view mode.'}
      </p>
      <label className={styles.field}>
        <span>Linked to</span>
        <select
          value={value}
          disabled={isLoading || isError}
          onChange={(e) => onChange({ cameraId: e.target.value || undefined })}
        >
          <option value="">Not linked</option>
          {(cameras ?? []).map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}
              {c.name ? ` — ${c.name}` : ''}
              {c.station ? ` (${c.station})` : ''}
            </option>
          ))}
        </select>
      </label>
      {/* The defect table is a property of the whole drawing, not of this
          symbol, but this is the only place anyone goes looking for it — an
          admin reaches an empty "Linked to" list and needs the next step to be
          right here rather than on a toolbar they have to be told about. */}
      <button type="button" className={styles.linkButton} onClick={onConfigure}>
        {unconfigured ? 'Configure camera defect table…' : 'Edit camera defect table…'}
      </button>
    </div>
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
export default function SymbolOptions({ node, slug, onChange, onCameraDefect }) {
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

  if (node.type === 'table') {
    return <TableStructure node={node} onChange={onChange} />
  }

  if (node.type === 'ipcamera') {
    return <CameraLink node={node} slug={slug} onChange={onChange} onConfigure={onCameraDefect} />
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
            placeholder="a > 80"
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
          <code>and</code> / <code>or</code> / <code>not</code>. <code>a</code> is the
          reading after its expression has been applied — or, on a column
          mapped to named states, the name itself. On a text column compare
          against a quoted word — <code>a == &apos;FAULT&apos;</code> — which
          ignores case and surrounding spaces.
        </p>
      </div>
    )
  }

  return null
}
