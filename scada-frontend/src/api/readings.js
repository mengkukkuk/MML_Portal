import { apiClient } from './client'

/**
 * Live sensor-reading API — backs the real-time ECharts page (LivePage).
 * Mirrors the /api/readings router in scada-mml-backend/readings.py.
 *
 * Every endpoint answers for the datasources selected in the header, so the
 * responses are lists rather than single rows and each entry names its source.
 * `sources` reports one entry per selected source including the ones that
 * failed — an unreachable plant is not the same thing as a quiet one.
 */

export async function fetchDevices() {
  const { data } = await apiClient.get('/readings/devices')
  return data // { devices: [...], sources: [...] }
}

export async function fetchMetrics(deviceId) {
  const { data } = await apiClient.get('/readings/metrics', { params: { device_id: deviceId } })
  return data // { metrics: [...], sources: [...] }
}

export async function fetchLatest(deviceId, metric) {
  const { data } = await apiClient.get('/readings/latest', {
    params: { device_id: deviceId, metric },
  })
  return data // { readings: [{ device_id, metric, unit, ts, value, datasource_id, datasource_name }], sources }
}

export async function fetchSeries(deviceId, metric, minutes = 15) {
  const { data } = await apiClient.get('/readings/series', {
    params: { device_id: deviceId, metric, minutes },
  })
  return data // { series: [{ device_id, metric, unit, points, datasource_id, datasource_name }], sources }
}