import { create } from 'zustand'
import { fetchDevices } from '@/api/devices'

/**
 * devices — ported 1:1 from the Pinia store (src/stores/devices.js).
 * `onlineCount`/`degradedCount`/`offlineCount` were Pinia getters (derived,
 * memoized off `list`); here they're plain functions on the store object,
 * called as e.g. `useDevicesStore.getState().onlineCount()` or wrapped in a
 * selector `(s) => s.onlineCount()` — consumers should still prefer deriving
 * counts from `list` directly via TanStack Query where that's already wired
 * (see OverviewPage.jsx) to avoid an extra render-time function call.
 */
export const useDevicesStore = create((set, get) => ({
  list: [],
  loading: false,
  error: null,

  onlineCount: () => get().list.filter((d) => d.status === 'online').length,
  degradedCount: () => get().list.filter((d) => d.status === 'degraded').length,
  offlineCount: () => get().list.filter((d) => d.status === 'offline').length,

  async load() {
    set({ loading: true, error: null })
    try {
      const list = await fetchDevices()
      set({ list })
    } catch (e) {
      set({ error: e?.message || String(e) })
    } finally {
      set({ loading: false })
    }
  },
}))
