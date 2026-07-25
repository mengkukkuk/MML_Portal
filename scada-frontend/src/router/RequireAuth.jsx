import { Navigate, Outlet, useLocation, useMatches } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import TitleSync from './TitleSync.jsx'

/**
 * RequireAuth — root-level route guard, ported from Vue's single global
 * `router.beforeEach` (old src/router/index.js:88-111). Runs on every
 * navigation and inspects the matched routes' `handle` for three flags:
 *   - handle.requiresAuth  → bounce to /login?redirect=<fullPath> if signed out
 *   - handle.requiresRole  → bounce to / if the signed-in user's role doesn't match
 *   - handle.isLoginRoute  → bounce a signed-in user away from /login to /
 *
 * Pre-existing open-redirect (flagged, not fixed — see migration plan risks):
 * the redirect target is round-tripped verbatim from the current location,
 * same as Vue's `to.fullPath`. `/login?redirect=//evil.com` still works.
 */
export default function RequireAuth() {
  const location = useLocation()
  const matches = useMatches()
  const isLoggedIn = useAuthStore((s) => s.hasToken)
  const role = useAuthStore((s) => s.user?.role ?? null)

  const requiresAuth = matches.some((m) => m.handle?.requiresAuth)
  const requiresRole = matches.reduce((found, m) => m.handle?.requiresRole ?? found, null)
  const isLoginRoute = matches.some((m) => m.handle?.isLoginRoute)

  if (requiresAuth && !isLoggedIn) {
    const fullPath = `${location.pathname}${location.search}${location.hash}`
    return (
      <Navigate
        to={{ pathname: '/login', search: `?redirect=${encodeURIComponent(fullPath)}` }}
        replace
      />
    )
  }

  if (requiresRole && role !== requiresRole) {
    return <Navigate to="/" replace />
  }

  if (isLoginRoute && isLoggedIn) {
    return <Navigate to="/" replace />
  }

  return (
    <>
      <TitleSync />
      <Outlet />
    </>
  )
}
