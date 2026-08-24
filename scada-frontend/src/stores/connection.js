import { create } from 'zustand'

/**
 * connection — connectivity indicator shown in the header ConnectionPill,
 * plus the database state behind it.
 *
 * Three facts are tracked separately because they fail independently and an
 * operator needs to know which one it is: whether the API answers
 * (`apiReachable`), whether its database answers (`dbOk`), and whether it is
 * serving from the fallback database (`dbFallback`). `status` collapses those
 * into the pill's three severity levels; DbStatusBanner reads the raw flags to
 * say what actually happened.
 */
export const useConnectionStore = create((set) => ({
  status: 'connected', // 'connected' | 'degraded' | 'offline'
  lastHeartbeatAt: new Date().toISOString(),
  apiReachable: true,
  dbOk: true,
  dbFallback: false,

  markHeartbeat: (status = 'connected') =>
    set({ status, lastHeartbeatAt: new Date().toISOString() }),

  /**
   * Apply a /api/health response.
   *
   * Running on a fallback still works but is not normal ('degraded'); an
   * unreachable database means nothing loads or saves ('offline').
   */
  applyHealth: ({ db, db_fallback: dbFallback }) => {
    const dbOk = db === 'ok'
    return set({
      status: !dbOk ? 'offline' : dbFallback ? 'degraded' : 'connected',
      apiReachable: true,
      dbOk,
      dbFallback: Boolean(dbFallback),
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
