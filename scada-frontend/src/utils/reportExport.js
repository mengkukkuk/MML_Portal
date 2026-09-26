import ExcelJS from 'exceljs'
import { fetchReportLogs } from '@/api/reports'
import { isMultiSource } from '@/components/report/reportFormat'
import { describeRange } from '@/components/report/reportRange'

/**
 * Builds the xlsx export: Summary, Defect Reasons, Quality Exceptions, Defect
 * Batch Log.
 *
 * Every sheet is topped with the same provenance banner — window and
 * generation time. Once a spreadsheet leaves the app it loses all the context
 * the UI provided, so the banner is the only thing that travels with it.
 *
 * Times are written as text in server-local form rather than as Excel date
 * serials, because Excel would reinterpret them in the reader's own timezone —
 * the exact confusion the naive-local decision exists to avoid.
 */

const EXPORT_ROW_CAP = 100_000

const TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111A2C' } }
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2C48' } }

function fmtTs(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

const pct = (value) => (value == null ? null : Number(value.toFixed(2)))

/** Banner + column headers. Returns the row index the data should start on. */
function startSheet(sheet, columns, meta) {
  sheet.mergeCells(1, 1, 1, columns.length)
  const title = sheet.getCell(1, 1)
  title.value = `${meta.templateName} — ${meta.rangeLabel}`
  title.font = { bold: true, size: 13, color: { argb: 'FFE6EDF7' } }
  title.fill = TITLE_FILL

  sheet.mergeCells(2, 1, 2, columns.length)
  const note = sheet.getCell(2, 1)
  note.value = `Generated ${fmtTs(meta.generatedAt)} (plant server local time) · ${meta.cameraCount} cameras`
  note.font = { size: 9, italic: true, color: { argb: 'FF8A99B3' } }
  note.fill = TITLE_FILL
  note.alignment = { wrapText: true }
  sheet.getRow(2).height = 26

  const headerRow = sheet.getRow(4)
  headerRow.values = columns.map((c) => c.header)
  headerRow.font = { bold: true, color: { argb: 'FFE6EDF7' } }
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL
  })
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width ?? 16 }))
  sheet.views = [{ state: 'frozen', ySplit: 4 }]
  return 5
}

function addRows(sheet, startRow, columns, rows) {
  rows.forEach((row, i) => {
    const r = sheet.getRow(startRow + i)
    r.values = columns.map((c) => row[c.key] ?? null)
  })
}

function buildSummary(wb, result, meta) {
  const sheet = wb.addWorksheet('Summary')
  // A spreadsheet has no tooltip to fall back on: with two plants selected,
  // `Line 1 / CAM01` appears twice with different numbers and nothing on the
  // row says which is which. The column only appears when it is needed, so
  // single-plant exports keep the layout people already have macros against.
  const multi = isMultiSource(result.cameras ?? [])
  const columns = [
    ...(multi ? [{ header: 'Source', key: 'datasource_name', width: 20 }] : []),
    { header: 'Line', key: 'location', width: 16 },
    { header: 'Camera', key: 'name', width: 20 },
    { header: 'Inspected', key: 'inspected', width: 14 },
    { header: 'Defects', key: 'defects', width: 12 },
    { header: 'Defect rate (%)', key: 'defect_rate', width: 16 },
    { header: 'Worst defect', key: 'worst_defect', width: 20 },
    { header: 'Last seen', key: 'last_seen', width: 20 },
    { header: 'Status', key: 'status', width: 14 },
  ]
  const start = startSheet(sheet, columns, meta)

  const toRow = (c) => ({
    datasource_name: c.datasource_name ?? '',
    location: c.location ?? '',
    name: c.name ?? c.code ?? '',
    inspected: c.inspected ?? 0,
    defects: c.defects ?? 0,
    defect_rate: pct(c.defect_rate_pct),
    worst_defect: c.worst_defect ?? '',
    last_seen: fmtTs(c.last_seen),
    status: c.status ?? '',
  })

  const rows = (result.cameras ?? []).map(toRow)
  const t = result.totals
  if (t) {
    rows.push({
      ...toRow(t),
      datasource_name: '',
      location: 'ALL',
      name: `${t.camera_count} cameras`,
      worst_defect: '',
      last_seen: '',
      status: '',
    })
  }
  addRows(sheet, start, columns, rows)

  if (t) {
    const totalRow = sheet.getRow(start + rows.length - 1)
    totalRow.font = { bold: true }
  }
}

function buildPareto(wb, result, meta) {
  const rows = result.defect_reasons ?? []
  if (!rows.length) return
  const sheet = wb.addWorksheet('Defect Reasons')
  const columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Defect', key: 'defect', width: 46 },
    { header: 'Count', key: 'count', width: 14 },
    { header: 'Batches', key: 'batches', width: 14 },
    { header: 'Cumulative (%)', key: 'cumulative', width: 16 },
  ]
  const start = startSheet(sheet, columns, meta)
  addRows(
    sheet, start, columns,
    rows.map((r, i) => ({
      rank: i + 1,
      defect: r.defect,
      count: r.count,
      batches: r.batches,
      cumulative: r.cumulative_pct == null ? null : Number(r.cumulative_pct.toFixed(2)),
    })),
  )
}

function buildExceptions(wb, result, meta) {
  const exceptions = result.quality_exceptions
  if (!exceptions) return
  const sheet = wb.addWorksheet('Quality Exceptions')
  const columns = [
    { header: 'Camera', key: 'camera', width: 40 },
    { header: 'Severity', key: 'severity', width: 14 },
    { header: 'Defect rate (%)', key: 'rate', width: 16 },
  ]
  const start = startSheet(sheet, columns, meta)

  const rows = [
    ...Object.entries(exceptions.by_severity ?? {}).map(([severity, count]) => ({
      camera: `— all ${severity} cameras —`,
      severity,
      rate: count,
    })),
    ...(exceptions.top ?? []).map((c) => ({
      camera: `${c.location ?? '—'} / ${c.name ?? c.code ?? '—'}`,
      severity: c.severity,
      rate: pct(c.defect_rate_pct),
    })),
  ]
  addRows(sheet, start, columns, rows)
}

async function buildBatchLog(wb, meta, filters) {
  const sheet = wb.addWorksheet('Defect Batch Log')

  // Fetched before the columns are laid out: only the rows can say whether more
  // than one plant answered, and the Source column depends on that.
  const page = await fetchReportLogs({
    start: filters.start,
    end: filters.end,
    locations: filters.locations,
    cameraCodes: filters.cameraCodes,
    limit: EXPORT_ROW_CAP,
    offset: 0,
  })

  const columns = [
    { header: 'Time', key: 'at', width: 22 },
    ...(isMultiSource(page.rows ?? [])
      ? [{ header: 'Source', key: 'datasource_name', width: 20 }]
      : []),
    { header: 'Line', key: 'location', width: 16 },
    { header: 'Camera', key: 'name', width: 20 },
    { header: 'Batch', key: 'batch_id', width: 20 },
    { header: 'Total defects', key: 'total_defects', width: 16 },
  ]
  const start = startSheet(sheet, columns, meta)

  addRows(
    sheet, start, columns,
    (page.rows ?? []).map((r) => ({
      at: fmtTs(r.created_at),
      datasource_name: r.datasource_name ?? '',
      location: r.location ?? '',
      name: r.name ?? r.code ?? '',
      batch_id: r.batch_id ?? '',
      total_defects: r.total_defects ?? (r.defect_array ?? []).reduce((a, b) => a + (b || 0), 0),
    })),
  )

  // A silently short file would look authoritative. Say so, in the sheet.
  if (page.truncated) {
    const warn = sheet.getRow(start + (page.rows?.length ?? 0) + 1)
    warn.getCell(1).value =
      `TRUNCATED — ${page.total.toLocaleString()} rows matched, ` +
      `only the first ${EXPORT_ROW_CAP.toLocaleString()} are included. ` +
      `Narrow the window or the camera selection for a complete export.`
    warn.getCell(1).font = { bold: true, color: { argb: 'FFEF4444' } }
  }
}

/** Build the workbook and hand it to the browser as a download. */
export async function exportReportXlsx({ result, filters, templateName, rangeLabel }) {
  const meta = {
    templateName: templateName || 'Report',
    rangeLabel: rangeLabel || describeRange(filters.start, filters.end),
    generatedAt: result?.window?.generated_at ?? new Date(),
    cameraCount: result?.totals?.camera_count ?? 0,
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'MML Portal'
  wb.created = new Date()

  buildSummary(wb, result, meta)
  buildPareto(wb, result, meta)
  buildExceptions(wb, result, meta)
  await buildBatchLog(wb, meta, filters)

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const safeName = meta.templateName.replace(/[^\w\-. ]+/g, '_').trim() || 'report'
  const stamp = fmtTs(new Date()).replace(/[: ]/g, '-')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeName} ${stamp}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
