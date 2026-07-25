import { useEffect, useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from './router/routes.jsx'
import { bootstrapSession } from './lib/sessionBootstrap'

/**
 * App — gates the first render on the single-flight session bootstrap
 * promise (silent /auth/refresh via HttpOnly cookie). This reproduces
 * Vue's `router.beforeEach` "run once before the first navigation" behavior
 * so a cold load of a protected route with a valid cookie never flashes
 * the login page.
 */
export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false)

  useEffect(() => {
    let cancelled = false
    bootstrapSession().finally(() => {
      if (!cancelled) setBootstrapped(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!bootstrapped) return null

  return <RouterProvider router={router} />
}
