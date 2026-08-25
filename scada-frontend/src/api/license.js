import { apiClient } from './client'

/**
 * License API — offline signed-license status and activation.
 * Mirrors the /api/license router in scada-mml-backend. GET /status is
 * unauthenticated (reachable pre-login and while the app is hard-blocked);
 * POST /activate requires an admin token and accepts either pasted text or
 * a .lic file upload as multipart form data.
 */

export async function fetchLicenseStatus() {
  const { data } = await apiClient.get('/license/status')
  return data // { state, tier, site_name, customer_name, expires_at, days_to_expiry, grace_period_days, days_until_hard_block, entitlements, warn }
}

/**
 * Activate a license. Pass either `text` (pasted token) or `file` (a .lic
 * File/Blob) — not both. Resolves to the same shape as fetchLicenseStatus.
 */
export async function activateLicense({ text, file } = {}) {
  const form = new FormData()
  if (file) form.append('file', file)
  else if (text) form.append('text', text)
  const { data } = await apiClient.post('/license/activate', form)
  return data
}
