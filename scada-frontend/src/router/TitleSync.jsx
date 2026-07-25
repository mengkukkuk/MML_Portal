import { useEffect } from 'react'
import { useMatches } from 'react-router-dom'

/**
 * TitleSync — sets document.title from the deepest matched route's
 * `handle.title`, ported from Vue router's global `afterEach` (old
 * src/router/index.js:113-116). Reproduces the exact asymmetric spacing:
 * `${title} · MMLPortal` (one word after the separator) when a route has a
 * title, or the two-word fallback 'MML Portal' when it doesn't.
 */
export default function TitleSync() {
  const matches = useMatches()

  useEffect(() => {
    const withTitle = [...matches].reverse().find((m) => m.handle?.title)
    const title = withTitle?.handle?.title
    document.title = title ? `${title} · MMLPortal` : 'MML Portal'
  }, [matches])

  return null
}
