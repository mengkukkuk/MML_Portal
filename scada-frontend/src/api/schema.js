import { apiClient } from './client'

/**
 * Schema-introspection API — backs the generic table data source.
 * Mirrors the /api/schema router in scada-mml-backend/schema.py.
 */

export async function fetchSchemaTables() {
  const { data } = await apiClient.get('/schema/tables')
  return data // [{ table, label }]
}

export async function fetchSchemaColumns(table) {
  const { data } = await apiClient.get('/schema/columns', { params: { table } })
  return data // { value_columns, ts_columns, filter_columns }
}

export async function fetchSchemaValues(table, column, limit = 500) {
  const { data } = await apiClient.get('/schema/values', {
    params: { table, column, limit },
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
  return data // { value, ts }
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
  return data // { points: [{ ts, value }] }
}
