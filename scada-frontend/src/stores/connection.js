import { defineStore } from 'pinia'

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    status: 'connected', // 'connected' | 'degraded' | 'offline'
    lastHeartbeatAt: new Date().toISOString(),
  }),
  actions: {
    markHeartbeat(status = 'connected') {
      this.status = status
      this.lastHeartbeatAt = new Date().toISOString()
    },
  },
})
