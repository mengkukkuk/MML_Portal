import { apiClient } from './client'

/**
 * Report API — mirrors /api/reports in scada-mml-backend/reports.py.
 *
 * Reads and runs are open to any signed-in user; template and settings writes
 * are admin-only (enforced server-side).
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

// --- settings & catalog ----------------------------------------------------

export async function fetchReportSettings() {
  const { data } = await apiClient.get('/reports/settings')
  return data
}

export async function updateReportSettings(settings) {
  const { data } = await apiClient.put('/reports/settings', settings)
  return data
}

export async function fetchCatalog(refresh = false) {
  const { data } = await apiClient.get('/reports/catalog', {
    params: refresh ? { refresh: true } : {},
  })
  return data // [{ location, tag_name }]
}

// --- running ---------------------------------------------------------------

/**
 * Execute a report. `blocks` decides which projections the server computes —
 * omitting 'timeline' keeps per-interval rows out of the response entirely,
 * which is most of the payload.
 */
export async function runReport({
  start,
  end,
  locations = [],
  tagNames = [],
  blocks,
  paretoTopN,
  paretoRankBy,
}) {
  const body = {
    start: toNaive(start),
    end: toNaive(end),
    locations,
    tag_names: tagNames,
  }
  if (blocks) body.blocks = blocks
  if (paretoTopN) body.pareto_top_n = paretoTopN
  if (paretoRankBy) body.pareto_rank_by = paretoRankBy

  // Report runs scan the log table and legitimately outrun the client's default
  // 10s timeout on a wide window.
  const { data } = await apiClient.post('/reports/run', body, { timeout: 120_000 })
  return data
}

/** One page of raw event_logs rows. `total` drives the pager. */
export async function fetchReportLogs({
  start,
  end,
  locations = [],
  tagNames = [],
  search,
  limit = 50,
  offset = 0,
}) {
  const { data } = await apiClient.get('/reports/logs', {
    params: {
      start: toNaive(start),
      end: toNaive(end),
      locations,
      tag_names: tagNames,
      ...(search ? { search } : {}),
      limit,
      offset,
    },
    // axios serialises arrays as `locations[]=` by default; FastAPI's
    // `Query([])` wants repeated bare `locations=` keys.
    paramsSerializer: { indexes: null },
    timeout: 120_000,
  })
  return data // { total, limit, offset, truncated, rows }
}
