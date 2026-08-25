import { create } from 'zustand'
import { fetchLicenseStatus, activateLicense } from '@/api/license'
import { apiErrorMessage } from '@/api/client'

const EMPTY_STATUS = {
  state: 'missing',
  tier: null,
  site_name: null,
  customer_name: null,
  expires_at: null,
  days_to_expiry: null,
  grace_period_days: null,
  days_until_hard_block: null,
  entitlements: null,
  warn: false,
}

/**
 * license — offline signed-license status, mirroring the auth store's shape.
 * `checked` is false only until the first status fetch settles (success or
 * failure) — App.jsx's boot gate waits on it the same way it waits on
 * sessionBootstrap, so the app never briefly flashes an unlicensed screen.
 */
export const useLicenseStore = create((set, get) => ({
  ...EMPTY_STATUS,
  checked: false,
  loading: false,
  error: null,

  // Derived getters — plain functions, called as e.g. useLicenseStore.getState().isBlocked()
  isBlocked: () => get().state === 'missing' || get().state === 'blocked',
  isWarning: () => get().warn,
  hasFeature: (feature) => (get().entitlements?.features || []).includes(feature),

  // Called once on app start, alongside auth's bootstrapSession. Fails open:
  // if the status check itself can't be reached, we don't block the app on
  // that alone — every gated API call still enforces the real 402 via the
  // client interceptor, which calls markBlocked() when it happens.
  async initialize() {
    try {
      const data = await fetchLicenseStatus()
      set({ ...data, checked: true })
    } catch {
      set({ checked: true })
    }
  },

  async refresh() {
    return get().initialize()
  },

  // Fast local update from the response interceptor's 402 — avoids an extra
  // round trip just to learn what the failed request already told us.
  markBlocked(reason) {
    set({ state: reason === 'license_blocked' ? 'blocked' : 'missing' })
  },

  async activate({ text, file }) {
    set({ loading: true, error: null })
    try {
      const data = await activateLicense({ text, file })
      set({ ...data, checked: true })
      return data
    } catch (e) {
      set({ error: apiErrorMessage(e, 'License activation failed') })
      throw e
    } finally {
      set({ loading: false })
    }
  },
}))
