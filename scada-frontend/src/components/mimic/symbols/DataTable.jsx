import s from './symbols.module.css'

/**
 * DataTable — the one symbol on the sheet that draws *rows* rather than a
 * reading.
 *
 * Every other utility symbol answers a question about a single column: what
 * does it read now, is it above its limit, what word is in it. A table answers
 * the question that comes next — "and what are the last few?" — for a batch
 * log, a shift tally, an alarm tail. So it is the only symbol whose structure
 * an admin designs rather than merely binds: which columns, in what order, how
 * wide, how many rows.
 *
 * ## It looks like the counter on purpose
 *
 * The figures use the counter's typography exactly — mono, tabular, the same
 * recessed well on the same panel body. Two symbols on one drawing that both
 * report numbers and set them differently would read as two different systems.
 * The table is the counter's plural, and it should look like it.
 *
 * ## Rows arrive already narrowed
 *
 * The projection, the row limit and the ordering all happen in SQL (see
 * `/api/schema/rows`), so this component receives exactly what it draws. It
 * never filters or sorts — a table that quietly dropped rows it was handed
 * would make the row limit mean two different things.
 */

/** Matches MAX_TABLE_COLUMNS in schema.py — the endpoint rejects more. */
export const MAX_TABLE_COLUMNS = 8

/** Rows an admin may ask for. Beyond this the type is too small to read. */
export const MAX_TABLE_ROWS = 20

export const DEFAULT_TABLE_ROWS = 6

/* Mono tabular figures are all one advance, so character counting is exact —
 * the same reason the counter lays its digits out by hand rather than measuring
 * a box that has no intrinsic width in SVG. */
const CHAR_W = 0.62

/** Below this a row is a smudge, so the table draws fewer rows instead. */
const MIN_ROW_H = 13

/**
 * The column list an admin configured, normalised, or the bound column alone.
 *
 * A table with no structure yet is not broken — it is a table someone has just
 * dropped on the sheet — so it falls back to the one column the binding already
 * names and draws something real immediately.
 */
export function tableColumns(node) {
  const configured = node?.options?.columns
  const list = Array.isArray(configured)
    ? configured.filter((c) => c && typeof c.col === 'string' && c.col)
    : []
  if (list.length) return list.slice(0, MAX_TABLE_COLUMNS)
  const anchor = node?.binding?.value_col
  return anchor ? [{ col: anchor }] : []
}

/** How many rows this table asks for. */
export function tableRowLimit(node) {
  const n = Number(node?.options?.rows)
  if (!Number.isFinite(n)) return DEFAULT_TABLE_ROWS
  return Math.min(MAX_TABLE_ROWS, Math.max(1, Math.round(n)))
}

/** One cell, as text. Nulls print as a dash rather than the word "null". */
function cellText(value, spec) {
  if (value === null || value === undefined) return '–'
  if (typeof value === 'number') {
    return spec.decimals == null ? String(value) : value.toFixed(spec.decimals)
  }
  return String(value)
}

/** Truncate to what the column can actually show, with an ellipsis if cut. */
function fit(text, widthPx, fontPx) {
  const max = Math.floor(widthPx / (fontPx * CHAR_W))
  if (max < 1) return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

export default function DataTable({ node, tag }) {
  const { w, h } = node
  const columns = tableColumns(node)
  const data = tag?.table ?? null
  const rows = data?.rows ?? []
  const fault = !!data?.error

  const pad = Math.min(10, w * 0.05)
  const wellX = pad
  const wellY = Math.min(22, h * 0.17)
  const wellW = Math.max(8, w - pad * 2)
  const wellH = Math.max(8, h - wellY - pad)

  const headH = Math.min(20, wellH * 0.24)
  const bodyH = wellH - headH
  // Fewer, legible rows beat every row rendered as a hairline. The limit is
  // asked for in SQL; this is what the box can honour of it.
  const capacity = Math.max(1, Math.floor(bodyH / MIN_ROW_H))
  const shown = rows.slice(0, capacity)
  const hidden = rows.length - shown.length
  const rowH = shown.length ? bodyH / Math.max(shown.length, 1) : bodyH

  const cellPad = 5
  const gridW = wellW - cellPad * 2
  const weights = columns.map((c) => Math.max(0.25, Number(c.weight) || 1))
  const total = weights.reduce((a, b) => a + b, 0)

  let cursor = wellX + cellPad
  const geometry = columns.map((c, i) => {
    const cw = (weights[i] / total) * gridW
    const x = cursor
    cursor += cw
    return { spec: c, x, w: cw }
  })

  const fontPx = Math.min(rowH * 0.58, 14)
  const headPx = Math.min(headH * 0.55, 10)

  const statusClass = fault ? s.statusCrit : ''

  // Content is the row's identity, not its position: a table that gains a row
  // at the top pushes every other row down, and keying by index would re-mount
  // — and so re-animate — all of them. Keyed by what they say, only what
  // actually changed rolls in.
  const seen = new Map()
  const keyFor = (row) => {
    const base = columns.map((c) => String(row[c.col] ?? '')).join('\u001f')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return `${base}#${n}`
  }

  return (
    <g className={statusClass}>
      <rect className={s.body} x={0} y={0} width={w} height={h} rx={3} />
      <rect className={s.well} x={wellX} y={wellY} width={wellW} height={wellH} rx={2} />

      <text className={s.labelDim} x={wellX + 2} y={wellY - 5}>
        {node.tagId ?? node.binding?.table ?? 'table'}
      </text>

      {/* The row count, top right — a table showing six of forty is a different
          reading from a table showing all six it has. */}
      {!fault && rows.length > 0 && (
        <text
          className={s.labelDim}
          x={wellX + wellW}
          y={wellY - 5}
          textAnchor="end"
        >
          {hidden > 0 ? `${shown.length} of ${rows.length}` : `${rows.length} rows`}
        </text>
      )}

      {/* Headers. Set apart by a rule rather than a fill, so the well stays one
          continuous recess the way the counter's does. */}
      {geometry.map(({ spec, x, w: cw }) => (
        <text
          key={spec.col}
          className={s.tableHead}
          x={spec.align === 'right' ? x + cw - cellPad : x}
          y={wellY + headH - headH * 0.3}
          textAnchor={spec.align === 'right' ? 'end' : 'start'}
          style={{ fontSize: `${headPx}px` }}
        >
          {fit((spec.title || spec.col).toUpperCase(), cw - cellPad, headPx)}
        </text>
      ))}
      <line
        className={s.hair}
        x1={wellX + cellPad}
        y1={wellY + headH}
        x2={wellX + wellW - cellPad}
        y2={wellY + headH}
      />

      {shown.map((row, i) => (
        <g key={keyFor(row)} transform={`translate(0 ${wellY + headH + i * rowH})`}>
          <g className={s.roll}>
            {i > 0 && (
              <line
                className={s.tableRule}
                x1={wellX + cellPad}
                y1={0}
                x2={wellX + wellW - cellPad}
                y2={0}
              />
            )}
            {geometry.map(({ spec, x, w: cw }) => {
              const raw = row[spec.col]
              const right = spec.align === 'right'
                || (spec.align !== 'left' && typeof raw === 'number')
              return (
                <text
                  key={spec.col}
                  className={s.tableCell}
                  x={right ? x + cw - cellPad : x}
                  y={rowH / 2 + fontPx * 0.36}
                  textAnchor={right ? 'end' : 'start'}
                  style={{ fontSize: `${fontPx}px` }}
                >
                  {fit(cellText(raw, spec), cw - cellPad, fontPx)}
                </text>
              )
            })}
          </g>
        </g>
      ))}

      {/* The three states that are not rows, each said plainly rather than
          drawn as an empty grid the operator has to interpret. */}
      {(fault || columns.length === 0 || (!rows.length && data)) && (
        <text
          className={`${s.tableCell} ${fault ? s.counterFault : ''}`}
          x={wellX + wellW / 2}
          y={wellY + headH + bodyH / 2}
          textAnchor="middle"
          style={{ fontSize: `${Math.min(13, wellH * 0.16)}px` }}
        >
          {fault ? 'ERR' : columns.length === 0 ? 'no columns chosen' : 'no rows'}
        </text>
      )}
      {!data && !fault && columns.length > 0 && (
        <text
          className={s.tableCell}
          x={wellX + wellW / 2}
          y={wellY + headH + bodyH / 2}
          textAnchor="middle"
          style={{ fontSize: `${Math.min(13, wellH * 0.16)}px` }}
        >
          ––
        </text>
      )}

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
