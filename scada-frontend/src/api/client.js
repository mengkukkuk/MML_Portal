import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE || '/api'

export const apiClient = axios.create({
  baseURL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
  // Required: browser must send the HttpOnly refresh_token cookie on /auth/refresh
  withCredentials: true,
})

// ── In-memory access token ────────────────────────────────────────────────
// Stored here (module scope) so it survives navigations but not page reloads.
// Never written to localStorage — only readable by JS in this session.
let _accessToken = null

export function setAccessToken(token) {
  _accessToken = token
}

export function clearAccessToken() {
  _accessToken = null
}

// Attach access token to every request as Bearer header
apiClient.interceptors.request.use((config) => {
  if (_accessToken) config.headers.Authorization = `Bearer ${_accessToken}`
  return config
})

// ── 401 auto-refresh ──────────────────────────────────────────────────────
let isRefreshing = false
let pendingQueue = []

function drainQueue(newToken, error) {
  pendingQueue.forEach((cb) => (error ? cb.reject(error) : cb.resolve(newToken)))
  pendingQueue = []
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config

    // Skip refresh loop for the refresh endpoint itself
    const isRefreshCall = original.url?.includes('/auth/refresh')
    if (error.response?.status === 401 && !original._retry && !isRefreshCall) {
      original._retry = true

      if (isRefreshing) {
        return new Promise((resolve, reject) =>
          pendingQueue.push({ resolve, reject }),
        ).then((token) => {
          original.headers.Authorization = `Bearer ${token}`
          return apiClient(original)
        })
      }

      isRefreshing = true
      try {
        const { useAuthStore } = await import('@/stores/auth')
        const auth = useAuthStore()
        const newToken = await auth.refresh()
        drainQueue(newToken, null)
        original.headers.Authorization = `Bearer ${newToken}`
        return apiClient(original)
      } catch (refreshError) {
        drainQueue(null, refreshError)
        const { useAuthStore } = await import('@/stores/auth')
        const auth = useAuthStore()
        auth._clearSession()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    if (import.meta.env.DEV) {
      console.warn('[api]', error.config?.url, error.message)
    }
    return Promise.reject(error)
  },
)
