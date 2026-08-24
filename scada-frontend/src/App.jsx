import { useEffect, useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import CircularProgress from '@mui/material/CircularProgress'
import { router } from './router/routes.jsx'
import { bootstrapSession } from './lib/sessionBootstrap'
import { useHealthPoll } from './lib/useHealthPoll'

/**
 * App — gates the first render on the single-flight session bootstrap
 * promise (silent /auth/refresh via HttpOnly cookie). This reproduces
 * Vue's `router.beforeEach` "run once before the first navigation" behavior
 * so a cold load of a protected route with a valid cookie never flashes
 * the login page.
 */
export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false)

  // Runs during bootstrap too, so the login page can already say whether the
  // backend and its database are reachable.
  useHealthPoll()

  useEffect(() => {
    let cancelled = false
    bootstrapSession().finally(() => {
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

  return <RouterProvider router={router} />
}
