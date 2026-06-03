import { defineStore } from 'pinia'
import { login, logout, refreshToken, getProfile } from '@/api/auth'

const TOKEN_KEY = 'scada_token'
const REFRESH_KEY = 'scada_refresh'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    accessToken: localStorage.getItem(TOKEN_KEY) || null,
    refreshTokenValue: localStorage.getItem(REFRESH_KEY) || null,
    loading: false,
    error: null,
  }),

  getters: {
    isLoggedIn: (state) => !!state.accessToken,
    role: (state) => state.user?.role ?? null,
  },

  actions: {
    async signIn(username, password) {
      this.loading = true
      this.error = null
      try {
        const data = await login(username, password)
        this._saveTokens(data.access_token, data.refresh_token)
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
        if (this.refreshTokenValue) {
          await logout(this.refreshTokenValue)
        }
      } finally {
        this._clearTokens()
      }
    },

    async loadUser() {
      if (!this.accessToken) return
      try {
        this.user = await getProfile()
      } catch (e) {
        // Only clear session on auth failure (401/403), NOT on network/server errors
        const status = e?.response?.status
        if (status === 401 || status === 403) {
          this._clearTokens()
        }
        // Network error / 500 → keep token, user stays logged in
      }
    },

    async refresh() {
      if (!this.refreshTokenValue) throw new Error('No refresh token')
      const data = await refreshToken(this.refreshTokenValue)
      this._saveTokens(data.access_token, this.refreshTokenValue)
      return data.access_token
    },

    _saveTokens(access, refresh) {
      this.accessToken = access
      this.refreshTokenValue = refresh
      localStorage.setItem(TOKEN_KEY, access)
      localStorage.setItem(REFRESH_KEY, refresh)
    },

    _clearTokens() {
      this.accessToken = null
      this.refreshTokenValue = null
      this.user = null
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(REFRESH_KEY)
    },
  },
})
