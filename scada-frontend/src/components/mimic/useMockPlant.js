import { useCallback, useEffect, useRef, useState } from 'react'
import { createPlantSim } from './mockPlant'

/**
 * useMockPlant — drives `createPlantSim` on an interval and hands the page a
 * snapshot in the same shape a real poll would return.
 *
 * The simulator instance lives in a ref so changing `tickMs` re-arms the
 * timer without resetting the plant (history and the event log survive a
 * cadence change, exactly as they would if this were a real datasource).
 */
export default function useMockPlant({ tickMs = 1000 } = {}) {
  const simRef = useRef(null)
  if (!simRef.current) simRef.current = createPlantSim()

  const [snapshot, setSnapshot] = useState(() => simRef.current.tick())

  useEffect(() => {
    // `tickMs: null` means "don't run" — the page is on live data and this
    // hook is only still mounted because hooks can't be called conditionally.
    // It must return before setInterval: `setInterval(fn, null)` coerces the
    // delay to 0 and spins the simulator as fast as the event loop allows.
    if (tickMs == null) return undefined
    const id = setInterval(() => setSnapshot(simRef.current.tick()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])

  // Pushes one tag past its high-high limit for ~15s. Without this the
  // alarm-state colours and the crit pulse are untestable by hand — the
  // generator otherwise keeps every tag comfortably inside its band.
  const simulateExcursion = useCallback((tagId) => {
    simRef.current.excite(tagId)
    setSnapshot(simRef.current.tick())
  }, [])

  return { ...snapshot, simulateExcursion }
}
