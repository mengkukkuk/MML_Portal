import { apiClient } from './client'

/**
 * Schema-introspection API — backs the generic table data source.
 * Mirrors the /api/schema router in scada-mml-backend/schema.py.
 *
 * The three catalogue calls take an optional `datasourceId` so the panel editor
 * can browse a connection the operator has not selected. The two data calls
 * (`latest`, `series`) don't: they answer for the datasources selected in the
 * header, returning one entry per source alongside a `sources` report. That is
 * what makes a dashboard portable — the same panel follows the header instead
 * of being pinned to the connection it was authored against.
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

export async function fetchSchemaLatest({ table, valueCol, filterCol, filterVal, tsCol }) {
  const { data } = await apiClient.get('/schema/latest', {
    params: {
      table,
      value_col: valueCol,
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      ts_col: tsCol || undefined,
    },
  })
  return data // { readings: [{ value, ts, datasource_id, datasource_name }], sources }
}

export async function fetchSchemaSeries({ table, valueCol, tsCol, filterCol, filterVal, minutes = 15 }) {
  const { data } = await apiClient.get('/schema/series', {
    params: {
      table,
      value_col: valueCol,
      ts_col: tsCol,
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      minutes,
    },
  })
  return data // { series: [{ points: [{ ts, value }], datasource_id, datasource_name }], sources }
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
