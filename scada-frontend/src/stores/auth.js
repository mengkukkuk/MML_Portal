import { create } from 'zustand'
import { login, logout, refreshToken, getProfile, register } from '@/api/auth'
import { setAccessToken, clearAccessToken, apiErrorMessage } from '@/api/client'
import { useDatasourceSelectionStore } from '@/stores/datasourceSelection'

/**
 * auth — ported 1:1 from the Pinia store (src/stores/auth.js).
 * Access token lives in module memory (api/client.js), not in this store —
 * we keep a boolean (`hasToken`) so components can reactively check
 * isLoggedIn without ever touching the token itself.
 */
export const useAuthStore = create((set, get) => ({
  user: null,
  hasToken: false,
  loading: false,
  error: null,

  // Derived getters — plain functions, called as e.g. useAuthStore.getState().isLoggedIn()
  isLoggedIn: () => get().hasToken,
  role: () => get().user?.role ?? null,

  // Called once on app start — silently restore session via refresh cookie
  async initialize() {
    try {
      const data = await refreshToken()
      setAccessToken(data.access_token)
      set({ hasToken: true, user: data.user })
    } catch {
      // No valid cookie → not logged in, stay on the login page
      get()._clearSession()
    }
  },

  async signIn(username, password) {
    set({ loading: true, error: null })
    try {
      const data = await login(username, password)
      // access_token → module memory only (never localStorage)
      setAccessToken(data.access_token)
      set({ hasToken: true, user: data.user })
    } catch (e) {
      // FastAPI answers with `detail`, not `message` — reading the wrong key
      // discarded the real reason (e.g. the 503 raised when the database is
      // unreachable) and showed a misleading generic failure instead.
      set({ error: apiErrorMessage(e, 'Login failed') })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  async signUp(payload) {
    set({ loading: true, error: null })
    try {
      const data = await register(payload)
      setAccessToken(data.access_token)
      set({ hasToken: true, user: data.user })
    } catch (e) {
      set({ error: apiErrorMessage(e, 'Registration failed') })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  async signOut() {
    try {
      await logout() // server clears HttpOnly cookie
    } finally {
      get()._clearSession()
    }
  },

  async refresh() {
    // Browser sends HttpOnly cookie automatically — no token in request body
    const data = await refreshToken()
    setAccessToken(data.access_token)
    set((state) => ({ hasToken: true, user: data.user ?? state.user }))
    return data.access_token
  },

  async loadUser() {
    if (!get().hasToken) return
    try {
      const user = await getProfile()
      set({ user })
    } catch (e) {
      const status = e?.response?.status
      if (status === 401 || status === 403) {
        get()._clearSession()
      }
    }
  },

  _clearSession() {
    clearAccessToken()
    // The datasource selection is per user and lives on the server. Dropping the
    // local mirror stops the next sign-in from briefly rendering the previous
    // user's plants — and from keying its first queries by them.
    useDatasourceSelectionStore.getState().reset()
    set({ hasToken: false, user: null })
  },
}))
