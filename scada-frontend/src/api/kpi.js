import { apiClient } from './client'

/**
 * Management-block API — the figures behind the Live grid's Loss meter, Andon
 * board and Loss waterfall. Mirrors scada-mml-backend/kpi.py. The server strips
 * every ฿ figure for roles that may not see cost (`cost_visible: false`).
 */

export async function fetchKpiSummary(panelId) {
  const { data } = await apiClient.get('/kpi/summary', { params: { panel_id: panelId } })
  return data
  // { generated_at, period: { name, start, end, elapsed_min },
  //   families: [{ key, label, state, state_since, speed, target, target_source, run_pct,
  //                minutes, strip: [{ start, end, state }], pieces, defects, good,
  //                stop_loss, slow_loss, pending, potential, lost, baht? }],
  //   totals: { pieces, defects, good, stop_loss, slow_loss, pending, potential, lost, baht? },
  //   compare?: { …same keys as totals }, unscheduled_min, cost_per_piece?,
  //   settings: { max_loss_stop_min, run_ratio, working_hours, mode }, cost_visible }
}

/** Admin only: the same summary for unsaved inspector settings. */
export async function previewKpi({ chart_type, table_name, datasource_id, kpi }) {
  const { data } = await apiClient.post('/kpi/preview', {
    chart_type, table_name, datasource_id, options: { kpi },
  })
  return data // same shape as fetchKpiSummary
}
