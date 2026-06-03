import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE || '/api'

export const apiClient = axios.create({
  baseURL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT token to every request
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('scada_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401: try refresh once, then redirect to login
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

    // Skip the refresh logic for the refresh endpoint itself (prevents infinite loop)
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
        // Lazy import to avoid circular dep
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
        auth._clearTokens()
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
