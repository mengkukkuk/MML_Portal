import { apiClient } from './client'

/**
 * Schema-introspection API — backs the generic table data source.
 * Mirrors the /api/schema router in scada-mml-backend/schema.py.
 *
 * Every call takes an optional `datasourceId`: when set, the catalogue and data
 * come from that saved connection's database/schema instead of the app DB.
 * `datasource_id` is only sent when provided, so existing app-DB calls are
 * unchanged.
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
  return data // { value_columns, ts_columns, filter_columns }
}

export async function fetchSchemaValues(table, column, limit = 500, datasourceId) {
  const { data } = await apiClient.get('/schema/values', {
    params: { table, column, limit, datasource_id: datasourceId ?? undefined },
  })
  return data // [string]
}

export async function fetchSchemaLatest({ table, valueCol, filterCol, filterVal, tsCol, datasourceId }) {
  const { data } = await apiClient.get('/schema/latest', {
    params: {
      table,
      value_col: valueCol,
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      ts_col: tsCol || undefined,
      datasource_id: datasourceId ?? undefined,
    },
  })
  return data // { value, ts }
}

export async function fetchSchemaSeries({ table, valueCol, tsCol, filterCol, filterVal, minutes = 15, datasourceId }) {
  const { data } = await apiClient.get('/schema/series', {
    params: {
      table,
      value_col: valueCol,
      ts_col: tsCol,
      filter_col: filterCol || undefined,
      filter_val: filterVal ?? undefined,
      minutes,
      datasource_id: datasourceId ?? undefined,
    },
  })
  return data // { points: [{ ts, value }] }
}
