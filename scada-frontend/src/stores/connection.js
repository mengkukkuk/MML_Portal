import { create } from 'zustand'

/**
 * connection — connectivity indicator shown in the header ConnectionPill,
 * plus the database state behind it.
 *
 * Two facts are tracked separately because they fail independently and an
 * operator needs to know which one it is: whether the API answers
 * (`apiReachable`) and whether its config database answers (`dbOk`). `status`
 * collapses those into the pill's severity levels; DbStatusBanner reads the raw
 * flags to say what actually happened.
 *
 * `dbOk` describes the *app/config* database only — always localhost. Plant
 * connectivity is per-datasource and reported alongside each source's data, not
 * here, because one unreachable plant is not an outage of the product.
 */
export const useConnectionStore = create((set) => ({
  status: 'connected', // 'connected' | 'degraded' | 'offline'
  lastHeartbeatAt: new Date().toISOString(),
  apiReachable: true,
  dbOk: true,

  markHeartbeat: (status = 'connected') =>
    set({ status, lastHeartbeatAt: new Date().toISOString() }),

  /**
   * Apply a /api/health response. An unreachable config database means nothing
   * loads or saves ('offline').
   */
  applyHealth: ({ db }) => {
    const dbOk = db === 'ok'
    return set({
      status: dbOk ? 'connected' : 'offline',
      apiReachable: true,
      dbOk,
      lastHeartbeatAt: new Date().toISOString(),
    })
  },

  /** The API itself could not be reached — a different fault to a dead DB. */
  markOffline: () =>
    set({
      status: 'offline',
      apiReachable: false,
      dbOk: false,
      lastHeartbeatAt: new Date().toISOString(),
    }),
}))
