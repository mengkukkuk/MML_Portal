import { defineStore } from 'pinia'
import { fetchDevices } from '@/api/devices'

export const useDevicesStore = defineStore('devices', {
  state: () => ({
    list: [],
    loading: false,
    error: null,
  }),
  getters: {
    onlineCount: (state) => state.list.filter((d) => d.status === 'online').length,
    degradedCount: (state) => state.list.filter((d) => d.status === 'degraded').length,
    offlineCount: (state) => state.list.filter((d) => d.status === 'offline').length,
  },
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        this.list = await fetchDevices()
      } catch (e) {
        this.error = e?.message || String(e)
      } finally {
        this.loading = false
      }
    },
  },
})
