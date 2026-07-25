import { create } from 'zustand'
import { fetchRecentAlarms, fetchActiveAlarms, acknowledgeAlarm } from '@/api/alarms'

/**
 * alarms — ported 1:1 from the Pinia store (src/stores/alarms.js).
 * `unacknowledgedCount`/`criticalCount` were Pinia getters (derived off
 * `alarms`); here they're plain functions on the store object — call as
 * `useAlarmsStore.getState().criticalCount()` or via a selector
 * `(s) => s.criticalCount()`.
 *
 * NOTE: AlarmsPage.jsx does NOT drive its polling or ack-mutation off this
 * store — it uses TanStack Query directly (refetchInterval for the two
 * pollers, useMutation for acknowledge) per the migration plan, the same way
 * DevicesPage/OverviewPage dropped the Pinia devices store for useQuery.
 * This store exists for parity and for any other consumer that wants a
 * plain alarms snapshot (e.g. counts) without standing up its own query.
 */
export const useAlarmsStore = create((set, get) => ({
  alarms: [],
  activeAlarms: [],
  loading: false,
  activeLoading: false,
  error: null,
  activeError: null,
  updatedAt: null,
  acking: new Set(),

  unacknowledgedCount: () => get().alarms.filter((a) => !a.acknowledged).length,
  criticalCount: () => get().alarms.filter((a) => a.severity === 'critical').length,

  async load(limit = 10) {
    set({ loading: true, error: null })
    try {
      const alarms = await fetchRecentAlarms(limit)
      set({ alarms, updatedAt: new Date() })
    } catch (e) {
      set({ error: e?.response?.data?.detail || e?.message || String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async loadActive() {
    // Independent of load(): a failure here must never break the log stack.
    // Guard against overlap so a fast poll can't pile up if a request is slow.
    if (get().activeLoading) return
    set({ activeLoading: true, activeError: null })
    try {
      const activeAlarms = await fetchActiveAlarms()
      set({ activeAlarms })
    } catch (e) {
      set({ activeError: e?.response?.data?.detail || e?.message || String(e) })
    } finally {
      set({ activeLoading: false })
    }
  },

  async acknowledge(id) {
    if (get().acking.has(id)) return
    set((state) => ({ acking: new Set(state.acking).add(id) }))
    try {
      const updated = await acknowledgeAlarm(id)
      set((state) => {
        const i = state.alarms.findIndex((x) => x.id === id)
        if (i === -1) return {}
        const alarms = [...state.alarms]
        alarms[i] = { ...alarms[i], ...updated }
        return { alarms }
      })
    } catch (e) {
      set({ error: e?.response?.data?.detail || e?.message || String(e) })
    } finally {
      set((state) => {
        const acking = new Set(state.acking)
        acking.delete(id)
        return { acking }
      })
    }
  },
}))
