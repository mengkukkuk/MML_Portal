import { defineStore } from 'pinia'
import { fetchRecentAlarms, fetchActiveAlarms, acknowledgeAlarm } from '@/api/alarms'

export const useAlarmsStore = defineStore('alarms', {
  state: () => ({
    alarms: [],
    activeAlarms: [],
    loading: false,
    activeLoading: false,
    error: null,
    activeError: null,
    updatedAt: null,
    acking: new Set(),
  }),
  getters: {
    unacknowledgedCount: (state) => state.alarms.filter((a) => !a.acknowledged).length,
    criticalCount: (state) => state.alarms.filter((a) => a.severity === 'critical').length,
  },
  actions: {
    async load(limit = 10) {
      this.loading = true
      this.error = null
      try {
        this.alarms = await fetchRecentAlarms(limit)
        this.updatedAt = new Date()
      } catch (e) {
        this.error = e?.response?.data?.detail || e?.message || String(e)
      } finally {
        this.loading = false
      }
    },
    async loadActive() {
      // Independent of load(): a failure here must never break the log stack.
      // Guard against overlap so the ~1s poll can't pile up if a request is slow.
      if (this.activeLoading) return
      this.activeLoading = true
      this.activeError = null
      try {
        this.activeAlarms = await fetchActiveAlarms()
      } catch (e) {
        this.activeError = e?.response?.data?.detail || e?.message || String(e)
      } finally {
        this.activeLoading = false
      }
    },
    async acknowledge(id) {
      if (this.acking.has(id)) return
      this.acking.add(id)
      try {
        const updated = await acknowledgeAlarm(id)
        const i = this.alarms.findIndex((x) => x.id === id)
        if (i !== -1) this.alarms[i] = { ...this.alarms[i], ...updated }
      } catch (e) {
        this.error = e?.response?.data?.detail || e?.message || String(e)
      } finally {
        this.acking.delete(id)
      }
    },
  },
})
