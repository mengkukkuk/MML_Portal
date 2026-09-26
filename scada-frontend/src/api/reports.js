import { apiClient } from './client'

/**
 * Report API — mirrors /api/reports in scada-mml-backend/reports.py.
 *
 * Reads and runs are open to any signed-in user; template writes are
 * admin-only (enforced server-side).
 *
 * Templates come from the app's own config database; everything that reads a
 * log table answers for the datasources selected in the header. A camera's
 * identity is therefore `(datasource_id, location, code)` — two plants
 * routinely both have a `Line 1 / CAM01`, and merging them would add one
 * plant's defects to the other's.
 *
 * ⚠ Timestamps: the backend works in naive server-local time end to end (its
 * `datetime.now()` is naive, and comparing that to a tz-aware value raises).
 * `toNaive()` below is therefore not cosmetic — sending `.toISOString()`, which
 * appends `Z`, makes /run fail. Every datetime leaving this module goes through
 * it.
 */

/** dayjs | Date | string → 'YYYY-MM-DDTHH:mm:ss' with no zone suffix. */
export function toNaive(value) {
  if (value == null) return value
  if (typeof value.format === 'function') return value.format('YYYY-MM-DDTHH:mm:ss')
  const d = value instanceof Date ? value : new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

// --- templates -------------------------------------------------------------

export async function fetchTemplates() {
  const { data } = await apiClient.get('/reports/templates')
  return data
}

export async function fetchDefaultTemplate() {
  const { data } = await apiClient.get('/reports/templates/default')
  return data
}

export async function fetchTemplate(id) {
  const { data } = await apiClient.get(`/reports/templates/${id}`)
  return data
}

export async function createTemplate(template) {
  const { data } = await apiClient.post('/reports/templates', template)
  return data
}

export async function updateTemplate(id, template) {
  const { data } = await apiClient.put(`/reports/templates/${id}`, template)
  return data
}

export async function deleteTemplate(id) {
  await apiClient.delete(`/reports/templates/${id}`)
}

// --- catalog -----------------------------------------------------------------

export async function fetchCatalog(refresh = false) {
  const { data } = await apiClient.get('/reports/catalog', {
    params: refresh ? { refresh: true } : {},
  })
  // A flat merged list, not an envelope — the filter pickers consume it
  // directly and an unreachable source simply contributes no options.
  return data // [{ location, code, name, datasource_id, datasource_name }]
}

// --- running ---------------------------------------------------------------

/**
 * Execute a report. `blocks` decides which projections the server computes —
 * omitting 'timeline' keeps per-hour rows out of the response entirely, and
 * omitting both 'pareto' and 'summary_table' skips the per-batch defect-log
 * fetch, which is most of the payload.
 */
export async function runReport({
  start,
  end,
  locations = [],
  cameraCodes = [],
  blocks,
  paretoTopN,
  paretoRankBy,
  exceptionsWarnPct,
  exceptionsCritPct,
  exceptionsTopN,
}) {
  const body = {
    start: toNaive(start),
    end: toNaive(end),
    locations,
    camera_codes: cameraCodes,
  }
  if (blocks) body.blocks = blocks
  if (paretoTopN) body.pareto_top_n = paretoTopN
  if (paretoRankBy) body.pareto_rank_by = paretoRankBy
  if (exceptionsWarnPct != null) body.exceptions_warn_pct = exceptionsWarnPct
  if (exceptionsCritPct != null) body.exceptions_crit_pct = exceptionsCritPct
  if (exceptionsTopN) body.exceptions_top_n = exceptionsTopN

  // Report runs scan the log table and legitimately outrun the client's default
  // 10s timeout on a wide window.
  const { data } = await apiClient.post('/reports/run', body, { timeout: 120_000 })
  // { window, totals, cameras: [{ …, datasource_id, datasource_name }],
  //   sources: [{ datasource_id, datasource_name, ok, error }], … }
  return data
}

/**
 * One page of raw camera_defect_logs rows (per-batch), merged across the
 * selected sources. `total` drives the pager; `sources` reports the ones that
 * did not answer.
 */
export async function fetchReportLogs({
  start,
  end,
  locations = [],
  cameraCodes = [],
  search,
  limit = 50,
  offset = 0,
}) {
  const { data } = await apiClient.get('/reports/logs', {
    params: {
      start: toNaive(start),
      end: toNaive(end),
      locations,
      camera_codes: cameraCodes,
      ...(search ? { search } : {}),
      limit,
      offset,
    },
    // axios serialises arrays as `locations[]=` by default; FastAPI's
    // `Query([])` wants repeated bare `locations=` keys.
    paramsSerializer: { indexes: null },
    timeout: 120_000,
  })
  return data // { total, limit, offset, truncated, rows, sources }
}
