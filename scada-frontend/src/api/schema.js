import { apiClient } from './client'
import { createLatestBatcher } from './latestBatcher'

/**
 * Schema-introspection API — backs the generic table data source.
 * Mirrors the /api/schema router in scada-mml-backend/schema.py.
 *
 * All five calls take an optional `datasourceId`. The three catalogue calls use
 * it so the panel editor can browse a connection the operator has not selected.
 * The two data calls (`latest`, `series`) bypass the header entirely when it's
 * given — a symbol pinned to one plant keeps reading it — and otherwise fan out
 * over the datasources selected in the header, returning one entry per source
 * alongside a `sources` report. Omitting it is what makes a binding portable —
 * it follows the header instead of being pinned to one connection.
 */

export async function fetchSchemaTables(datasourceId) {
  const { data } = await apiClient.get('/schema/tables', {
    params: { datasource_id: datasourceId ?? undefined },
  })
  return data // [{ table, label }]
}

export async function fetchSchemaColumns(table, datasourceId) {
  const { data } = await apiClient.get('/schema/columns', {
    params: { table, datasource_id: datasourceId ?? undefined },
  })
  // value_columns is numeric; text_columns is the printable-but-not-plottable
  // set, offered only to symbols that render a word.
  return data // { value_columns, ts_columns, text_columns, filter_columns }
}

export async function fetchSchemaValues(table, column, limit = 500, datasourceId) {
  const { data } = await apiClient.get('/schema/values', {
    params: { table, column, limit, datasource_id: datasourceId ?? undefined },
  })
  return data // [string]
}

const latestBatch = createLatestBatcher(async (items) => {
  const { data } = await apiClient.post('/schema/latest/batch', { items })
  return data.results
})

/**
 * Newest row for one binding. Called once per series/symbol per poll; calls made
 * together are sent as one POST /schema/latest/batch (see latestBatcher.js), so
 * callers keep this one-binding signature and the same resolve/reject shapes.
 */
export function fetchSchemaLatest({
  table, valueCol, filterCol, filterVal, tsCol, datasourceId,
}) {
  // The batch is validated as a whole, so one unfinished binding (a dialog
  // mid-edit) would 422 every symbol it was batched with. Refuse it alone, as
  // the standalone GET would have.
  if (!table || !valueCol) {
    const err = new Error('table and valueCol are required')
    err.response = { status: 422, data: { detail: err.message } }
    return Promise.reject(err)
  }
  return latestBatch({
    table,
    value_col: valueCol,
    filter_col: filterCol || null,
    filter_val: filterVal == null ? null : String(filterVal),
    ts_col: tsCol || null,
    datasource_id: datasourceId ?? null,
  }) // { readings: [{ value, ts, datasource_id, datasource_name }], sources }
}

export async function fetchSchemaSeries({
  table, valueCol, tsCol, filterCol, filterVal, minutes = 15, start, end, limit, whole, step,
  datasourceId, signal,
}) {
  const { data } = await apiClient.get('/schema/series', {
    // Lets a caller drop a read nobody is waiting for (a zoom tile scrolled
    // past) instead of queueing it on a small plant connection pool.
    signal,
    params: {
      table,
      value_col: valueCol,
      ts_col: tsCol,
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      minutes: start && end ? undefined : minutes,
      start,
      end,
      // Omitted keeps the server's own default. Only a caller that can offer a
      // week-long window needs to think about the ceiling.
      limit: limit ?? undefined,
      // The whole window at any length: thinned to fit `limit` rather than
      // clipped to its newest rows (schema.py get_series).
      whole: whole || undefined,
      // A bucket size in seconds: the chart's resolution tier (trendDetail.js).
      step: step ?? undefined,
      datasource_id: datasourceId ?? undefined,
    },
  })
  // { series: [{ points: [{ ts, value }], truncated, datasource_id, datasource_name }], sources }
  // `value` is a number, or an array of them when value_col is a numeric-array
  // column — several readings taken at one instant.
  return data
}

/**
 * The newest `limit` rows of a table, narrowed to `columns`.
 *
 * The wide read: `latest` answers "what does this column say now", this answers
 * "what do the last few rows say", which is what the mimic's table symbol
 * draws. Column names travel as one comma-joined string because that is the
 * shape the endpoint validates and de-duplicates.
 */
export async function fetchSchemaRows({
  table, columns, filterCol, filterVal, tsCol, limit = 10, datasourceId,
}) {
  const { data } = await apiClient.get('/schema/rows', {
    params: {
      table,
      cols: (columns || []).join(','),
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      ts_col: tsCol || undefined,
      limit,
      datasource_id: datasourceId ?? undefined,
    },
  })
  return data // { tables: [{ columns, rows, datasource_id, datasource_name }], sources }
}

/**
 * Pick the entry belonging to the *primary* (first-selected) source.
 *
 * Some callers can't fan out: a mimic symbol is one physical asset, and a
 * binding preview describes one connection. `sources` is ordered by the
 * operator's selection, so its first entry names the primary source.
 *
 * Matching on that id rather than taking `list[0]` is the whole point — a
 * source that has no matching row contributes no entry, so the plain first
 * element could silently be the *second* plant's value shown on the first
 * plant's symbol.
 */
export function fromPrimarySource(list, sources) {
  const primary = sources?.[0]?.datasource_id ?? null
  return (list || []).find((r) => (r.datasource_id ?? null) === primary) ?? null
}
