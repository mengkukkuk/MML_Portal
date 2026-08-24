import { useEffect } from 'react'
import { getHealth } from '@/api/health'
import { useConnectionStore } from '@/stores/connection'

const POLL_MS = 15_000

/**
 * useHealthPoll — keeps the connection store in step with the backend.
 *
 * Mounted once at the app root so it runs on the login page too: an operator
 * who cannot sign in needs to see *why* more than a signed-in one does.
 *
 * The poll is deliberately unauthenticated — /api/health takes no token, so it
 * keeps reporting through an outage that makes every other call fail.
 */
export function useHealthPoll() {
  useEffect(() => {
    let cancelled = false
    const { applyHealth, markOffline } = useConnectionStore.getState()

    async function tick() {
      try {
        const data = await getHealth()
        if (!cancelled) applyHealth(data)
      } catch {
        // Rejection here means the API is unreachable, not the database.
        if (!cancelled) markOffline()
      }
    }

    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
}
