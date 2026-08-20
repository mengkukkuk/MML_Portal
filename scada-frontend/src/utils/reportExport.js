import ExcelJS from 'exceljs'
import { fetchReportLogs } from '@/api/reports'
import { OEE_CAVEAT } from '@/components/report/reportFormat'
import { describeRange } from '@/components/report/reportRange'

/**
 * Builds the xlsx export: Summary, Downtime Reasons, Alarms, Event Log.
 *
 * Every sheet is topped with the same provenance banner — window, generation
 * time, and the OEE caveat. Once a spreadsheet leaves the app it loses all the
 * context the UI provided, and an availability-only OEE figure passed off as a
 * real OEE is a genuinely misleading business number. The banner is the only
 * thing that travels with it.
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

const hours = (seconds) => (seconds == null ? null : Number((seconds / 3600).toFixed(3)))
const pct = (ratio) => (ratio == null ? null : Number((ratio * 100).toFixed(2)))

/** Banner + column headers. Returns the row index the data should start on. */
function startSheet(sheet, columns, meta) {
  sheet.mergeCells(1, 1, 1, columns.length)
  const title = sheet.getCell(1, 1)
  title.value = `${meta.templateName} — ${meta.rangeLabel}`
  title.font = { bold: true, size: 13, color: { argb: 'FFE6EDF7' } }
  title.fill = TITLE_FILL

  sheet.mergeCells(2, 1, 2, columns.length)
  const note = sheet.getCell(2, 1)
  note.value =
    `Generated ${fmtTs(meta.generatedAt)} (plant server local time) · ` +
    `${meta.machineCount} machines · ${OEE_CAVEAT}`
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
  const columns = [
    { header: 'Line', key: 'location', width: 16 },
    { header: 'Machine', key: 'tag_name', width: 20 },
    { header: 'Runtime (h)', key: 'run_h' },
    { header: 'Stopped (h)', key: 'stop_h' },
    { header: 'Idle (h)', key: 'idle_h' },
    { header: 'Planned down (h)', key: 'planned_h', width: 18 },
    { header: 'Unmeasured (h)', key: 'unknown_h', width: 18 },
    { header: 'Downtime (h)', key: 'down_h' },
    { header: 'Coverage (%)', key: 'coverage' },
    { header: 'Availability (%)', key: 'availability', width: 18 },
    { header: 'OEE (A-only) (%)', key: 'oee', width: 18 },
    { header: 'Stops', key: 'stops', width: 10 },
    { header: 'MTBF (h)', key: 'mtbf_h' },
    { header: 'MTTR (h)', key: 'mttr_h' },
    { header: 'Alarms', key: 'alarms', width: 10 },
  ]
  const start = startSheet(sheet, columns, meta)

  const toRow = (m) => ({
    location: m.location ?? '',
    tag_name: m.tag_name ?? '',
    run_h: hours(m.run_s),
    stop_h: hours(m.stop_s),
    idle_h: hours(m.idle_s),
    planned_h: hours(m.planned_down_s),
    unknown_h: hours(m.unknown_s),
    down_h: hours(m.downtime_s),
    coverage: pct(m.coverage),
    availability: pct(m.availability),
    oee: pct(m.oee),
    stops: m.stop_count ?? 0,
    mtbf_h: hours(m.mtbf_s),
    mttr_h: hours(m.mttr_s),
    alarms: m.alarm_count ?? 0,
  })

  const rows = (result.machines ?? []).map(toRow)
  const t = result.totals
  if (t) {
    rows.push({
      ...toRow(t),
      location: 'ALL',
      tag_name: `${t.machine_count} machines`,
      coverage: null,
      alarms: (result.machines ?? []).reduce((n, m) => n + (m.alarm_count ?? 0), 0),
    })
  }
  addRows(sheet, start, columns, rows)

  if (t) {
    const totalRow = sheet.getRow(start + rows.length - 1)
    totalRow.font = { bold: true }
  }
}

function buildPareto(wb, result, meta) {
  const rows = result.downtime_reasons ?? []
  if (!rows.length) return
  const sheet = wb.addWorksheet('Downtime Reasons')
  const columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Reason', key: 'reason', width: 46 },
    { header: 'Downtime (h)', key: 'hours' },
    { header: 'Occurrences', key: 'count', width: 14 },
    { header: 'Cumulative (%)', key: 'cumulative', width: 16 },
  ]
  const start = startSheet(sheet, columns, meta)
  addRows(
    sheet, start, columns,
    rows.map((r, i) => ({
      rank: i + 1,
      reason: r.reason,
      hours: hours(r.seconds),
      count: r.count,
      cumulative: r.cumulative_pct == null ? null : Number(r.cumulative_pct.toFixed(2)),
    })),
  )
}

function buildAlarms(wb, result, meta) {
  const summary = result.alarm_summary
  if (!summary) return
  const sheet = wb.addWorksheet('Alarms')
  const columns = [
    { header: 'Alarm', key: 'alarm', width: 56 },
    { header: 'Severity', key: 'severity', width: 14 },
    { header: 'Count', key: 'count', width: 12 },
  ]
  const start = startSheet(sheet, columns, meta)

  const rows = [
    ...Object.entries(summary.by_severity ?? {}).map(([severity, count]) => ({
      alarm: `— all ${severity} alarms —`,
      severity,
      count,
    })),
    ...(summary.top ?? []),
  ]
  addRows(sheet, start, columns, rows)
}

async function buildEventLog(wb, meta, filters) {
  const sheet = wb.addWorksheet('Event Log')
  const columns = [
    { header: 'Time', key: 'at', width: 22 },
    { header: 'Line', key: 'location', width: 16 },
    { header: 'Machine', key: 'tag_name', width: 20 },
    { header: 'Event', key: 'event', width: 70 },
  ]
  const start = startSheet(sheet, columns, meta)

  const page = await fetchReportLogs({
    start: filters.start,
    end: filters.end,
    locations: filters.locations,
    tagNames: filters.tagNames,
    limit: EXPORT_ROW_CAP,
    offset: 0,
  })

  addRows(
    sheet, start, columns,
    (page.rows ?? []).map((r) => ({
      at: fmtTs(r.at_date_time),
      location: r.location ?? '',
      tag_name: r.tag_name ?? '',
      event: r.event ?? '',
    })),
  )

  // A silently short file would look authoritative. Say so, in the sheet.
  if (page.truncated) {
    const warn = sheet.getRow(start + (page.rows?.length ?? 0) + 1)
    warn.getCell(1).value =
      `TRUNCATED — ${page.total.toLocaleString()} rows matched, ` +
      `only the first ${EXPORT_ROW_CAP.toLocaleString()} are included. ` +
      `Narrow the window or the machine selection for a complete export.`
    warn.getCell(1).font = { bold: true, color: { argb: 'FFEF4444' } }
  }
}

/** Build the workbook and hand it to the browser as a download. */
export async function exportReportXlsx({ result, filters, templateName, rangeLabel }) {
  const meta = {
    templateName: templateName || 'Report',
    rangeLabel: rangeLabel || describeRange(filters.start, filters.end),
    generatedAt: result?.window?.generated_at ?? new Date(),
    machineCount: result?.totals?.machine_count ?? 0,
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'MML Portal'
  wb.created = new Date()

  buildSummary(wb, result, meta)
  buildPareto(wb, result, meta)
  buildAlarms(wb, result, meta)
  await buildEventLog(wb, meta, filters)

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
