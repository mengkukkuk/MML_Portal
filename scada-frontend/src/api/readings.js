import { apiClient } from './client'

/**
 * Live sensor-reading API — backs the real-time ECharts page (LivePage).
 * Mirrors the /api/readings router in scada-mml-backend/readings.py.
 */

export async function fetchDevices() {
  const { data } = await apiClient.get('/readings/devices')
  return data
}

export async function fetchMetrics(deviceId) {
  const { data } = await apiClient.get('/readings/metrics', { params: { device_id: deviceId } })
  return data
}

export async function fetchLatest(deviceId, metric) {
  const { data } = await apiClient.get('/readings/latest', {
    params: { device_id: deviceId, metric },
  })
  return data // { device_id, metric, unit, ts, value }
}

export async function fetchSeries(deviceId, metric, minutes = 15) {
  const { data } = await apiClient.get('/readings/series', {
    params: { device_id: deviceId, metric, minutes },
  })
  return data // { device_id, metric, unit, points: [{ ts, value }] }
}