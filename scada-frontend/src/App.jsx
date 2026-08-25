import { useEffect, useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import CircularProgress from '@mui/material/CircularProgress'
import { router } from './router/routes.jsx'
import { bootstrapSession } from './lib/sessionBootstrap'
import { useHealthPoll } from './lib/useHealthPoll'
import { useLicenseStore } from './stores/license'
import ActivateLicensePage from './pages/ActivateLicensePage.jsx'

/**
 * App — gates the first render on the single-flight session bootstrap
 * promise (silent /auth/refresh via HttpOnly cookie). This reproduces
 * Vue's `router.beforeEach` "run once before the first navigation" behavior
 * so a cold load of a protected route with a valid cookie never flashes
 * the login page.
 */
export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false)
  const isBlocked = useLicenseStore((s) => s.isBlocked())

  // Runs during bootstrap too, so the login page can already say whether the
  // backend and its database are reachable.
  useHealthPoll()

  useEffect(() => {
    let cancelled = false
    Promise.all([bootstrapSession(), useLicenseStore.getState().initialize()]).finally(() => {
      if (!cancelled) setBootstrapped(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Rendering null here meant a blank white page for however long the bootstrap
  // took — and with the API down that is the full 10s axios timeout, which
  // reads as "the app is broken" rather than "the app is waiting".
  if (!bootstrapped) {
    return (
      <div
        role="status"
        aria-label="Loading"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <CircularProgress />
      </div>
    )
  }

  // Rendered in place of the router entirely — not a route — so a blocked
  // install can't be navigated away from it via client-side routing. Every
  // gated API call would 402 anyway; this just avoids showing a broken app
  // shell that fails on every request.
  if (isBlocked) {
    return <ActivateLicensePage />
  }

  return <RouterProvider router={router} />
}
