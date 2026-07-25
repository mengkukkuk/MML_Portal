import { fmtValue } from './shared'

/**
 * Table — not an ECharts option; returns the plain row-model LivePanel.jsx
 * renders as an MUI Table (one value column per series, most recent readings
 * first). Mirrors the `tableRows` computed in LivePanel.vue.
 */
export default function buildTableRows(seriesList, opts = {}) {
  const max = Math.max(1, Number(opts.maxRows ?? 10))
  const cols = seriesList
  const longest = cols.reduce((m, s) => Math.max(m, s.points.length), 0)
  const rows = []
  for (let k = 0; k < Math.min(max, longest); k++) {
    const cells = cols.map((s) => {
      const p = s.points[s.points.length - 1 - k]
      return p ? fmtValue(p[1], opts.decimals) : '—'
    })
    let t = ''
    for (const s of cols) {
      const p = s.points[s.points.length - 1 - k]
      if (p) { t = new Date(p[0]).toLocaleTimeString(); break }
    }
    rows.push({ t, cells })
  }
  return rows
}
