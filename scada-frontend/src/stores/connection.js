import { create } from 'zustand'

/**
 * connection — ported 1:1 from the Pinia store (src/stores/connection.js).
 * Tracks a simple connectivity indicator shown in the header ConnectionPill.
 */
export const useConnectionStore = create((set) => ({
  status: 'connected', // 'connected' | 'degraded' | 'offline'
  lastHeartbeatAt: new Date().toISOString(),

  markHeartbeat: (status = 'connected') =>
    set({ status, lastHeartbeatAt: new Date().toISOString() }),
}))
