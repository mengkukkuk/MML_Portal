import { defineStore } from 'pinia'
import { fetchActiveAlarms } from '@/api/alarms'

export const useAlarmsStore = defineStore('alarms', {
  state: () => ({
    active: [],
    loading: false,
    error: null,
  }),
  getters: {
    unacknowledgedCount: (state) => state.active.filter((a) => !a.ack).length,
    criticalCount: (state) => state.active.filter((a) => a.severity === 'critical').length,
  },
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        this.active = await fetchActiveAlarms()
      } catch (e) {
        this.error = e?.message || String(e)
      } finally {
        this.loading = false
      }
    },
    acknowledge(id) {
      const a = this.active.find((x) => x.id === id)
      if (a) a.ack = true
    },
  },
})
