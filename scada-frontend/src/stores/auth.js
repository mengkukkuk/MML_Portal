import { defineStore } from 'pinia'
import { login, logout, refreshToken, getProfile } from '@/api/auth'
import { setAccessToken, clearAccessToken } from '@/api/client'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    // Access token lives in module memory (client.js), not Pinia state.
    // We keep a boolean here so components can reactively check isLoggedIn.
    _hasToken: false,
    loading: false,
    error: null,
  }),

  getters: {
    isLoggedIn: (state) => state._hasToken,
    role: (state) => state.user?.role ?? null,
  },

  actions: {
    // Called once on app start — silently restore session via refresh cookie
    async initialize() {
      try {
        const data = await refreshToken()
        setAccessToken(data.access_token)
        this._hasToken = true
        this.user = data.user
      } catch {
        // No valid cookie → not logged in, stay on login page
        this._clearSession()
      }
    },

    async signIn(username, password) {
      this.loading = true
      this.error = null
      try {
        const data = await login(username, password)
        // access_token → module memory only (never localStorage)
        setAccessToken(data.access_token)
        this._hasToken = true
        this.user = data.user
      } catch (e) {
        this.error = e?.response?.data?.message || 'Login failed'
        throw e
      } finally {
        this.loading = false
      }
    },

    async signOut() {
      try {
        await logout() // server clears HttpOnly cookie
      } finally {
        this._clearSession()
      }
    },

    async refresh() {
      // Browser sends HttpOnly cookie automatically — no token in request body
      const data = await refreshToken()
      setAccessToken(data.access_token)
      this._hasToken = true
      if (data.user) this.user = data.user
      return data.access_token
    },

    async loadUser() {
      if (!this._hasToken) return
      try {
        this.user = await getProfile()
      } catch (e) {
        const status = e?.response?.status
        if (status === 401 || status === 403) {
          this._clearSession()
        }
      }
    },

    _clearSession() {
      clearAccessToken()
      this._hasToken = false
      this.user = null
    },
  },
})
