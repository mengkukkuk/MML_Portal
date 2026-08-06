import { useMemo, useRef } from 'react'

/**
 * useValueTransition — turns a tag snapshot into the two facts an animated
 * symbol needs that the snapshot alone does not state:
 *
 *   dir     -1 | 0 | +1   direction of the last *displayed* change
 *   pulse   monotonically incrementing counter, bumped by the simulator only
 *           when the rounded readout actually changed
 *   crossed true when this change also moved the tag between status bands
 *
 * `pulse` is a counter and not a boolean on purpose. A boolean either never
 * clears (the ring stays lit) or re-fires on unrelated re-renders; a counter
 * is consumed with `key={pulse}`, so an unchanged tick re-mounts nothing and
 * therefore renders no ring at all.
 */
export default function useValueTransition(tag) {
  const lastDir = useRef(0)

  return useMemo(() => {
    if (!tag) return { dir: 0, pulse: 0, crossed: false, status: 'stale' }

    let dir = lastDir.current
    if (tag.display != null && tag.prevDisplay != null && tag.display !== tag.prevDisplay) {
      dir = tag.display > tag.prevDisplay ? 1 : -1
      lastDir.current = dir
    }

    return {
      dir,
      pulse: tag.pulse,
      crossed: tag.status !== tag.prevStatus,
      status: tag.status,
    }
  }, [tag])
}
