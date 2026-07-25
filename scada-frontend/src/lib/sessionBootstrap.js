import { useAuthStore } from '@/stores/auth'

/**
 * sessionBootstrap — module-scope single-flight replacement for Vue's
 * `router.beforeEach` "run once on first navigation" pattern
 * (old src/router/index.js:86-97). React has no equivalent hook, so App.jsx
 * awaits this promise and renders nothing until it settles.
 *
 * Defined at module scope (not inside a component/hook) so that React 18/19
 * StrictMode's deliberate double-invocation of effects/render in dev still
 * reuses the same in-flight promise — exactly one POST /api/auth/refresh,
 * never two.
 */
let bootstrapPromise = null

export function bootstrapSession() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const auth = useAuthStore.getState()
      if (!auth.isLoggedIn()) {
        await auth.initialize() // calls /auth/refresh with cookie
      }
    })()
  }
  return bootstrapPromise
}
