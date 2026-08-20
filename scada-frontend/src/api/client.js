import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE || '/api'

export const apiClient = axios.create({
  baseURL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
  // Required: the browser must send the HttpOnly refresh_token cookie on /auth/refresh
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

/**
 * Drop the instance's default JSON Content-Type when the body is multipart.
 *
 * This client sets `Content-Type: application/json` for every request, which is
 * right for the JSON API but wrong for a file upload: only the browser can write
 * the `boundary=...` parameter, and it declines to do so when the header is
 * already set explicitly. The request then goes out labelled JSON with a
 * multipart body, and the server sees a form with no fields in it — surfacing as
 * a 422 naming the file field as missing, which points nowhere near the cause.
 *
 * Removing the header lets the browser set one with a matching boundary. This
 * runs on retries too, which is what makes an upload survive a 401 refresh: by
 * then the header holds the *previous* attempt's boundary, which no longer
 * matches the re-serialised body.
 */
function stripMultipartContentType(config) {
  if (typeof FormData === 'undefined' || !(config.data instanceof FormData)) return
  const h = config.headers
  if (!h) return
  if (typeof h.delete === 'function') h.delete('Content-Type')
  else {
    delete h['Content-Type']
    delete h['content-type']
  }
}

// Attach an access token to every request as a Bearer header
apiClient.interceptors.request.use((config) => {
  if (_accessToken) config.headers.Authorization = `Bearer ${_accessToken}`
  stripMultipartContentType(config)
  return config
})

// ── 401 auto-refresh ──────────────────────────────────────────────────────
let isRefreshing = false
let pendingQueue = []

function drainQueue(newToken, error) {
  pendingQueue.forEach((cb) => (error ? cb.reject(error) : cb.resolve(newToken)))
  pendingQueue = []
}

// Transient failures (client-side timeout, dropped connection, or a gateway
// error from the IIS ARR proxy) get one quick retry before we give up — these
// are unrelated to auth and would otherwise surface as a bare rejection that
// callers like LivePanel's polling silently conflate with "no data".
const RETRYABLE_STATUSES = new Set([502, 503, 504])
const RETRY_DELAY_MS = 1500

function isRetryableFailure(error) {
  if (error.response) return RETRYABLE_STATUSES.has(error.response.status)
  // No response at all → network error or client-side timeout (ECONNABORTED).
  return true
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A message worth showing a user, from any axios rejection.
 *
 * FastAPI answers a handler's own `HTTPException` with a string `detail` but a
 * request-validation failure with a *list* of error objects. Rendering that list
 * straight into a component throws ("Objects are not valid as a React child")
 * and replaces the page with an error boundary — so the display of a 422 becomes
 * a worse bug than the 422. This flattens both shapes to a string.
 */
export function apiErrorMessage(error, fallback = 'Something went wrong.') {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        // `loc` is ['body', 'field', ...]; the field is the part a user can act on.
        const field = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : null
        return field ? `${field}: ${d?.msg ?? 'is not valid'}` : d?.msg
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return fallback
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config

    // Skip refresh for all /auth/ calls (login, refresh, forgot/reset-password).
    // These are public or unauthenticated flows — a 401/400 there is the real
    // error and must surface to the caller, not trigger a doomed token refresh.
    const isAuthCall = original.url?.includes('/auth/')
    if (error.response?.status === 401 && !original._retry && !isAuthCall) {
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
        const auth = useAuthStore.getState()
        const newToken = await auth.refresh()
        drainQueue(newToken, null)
        original.headers.Authorization = `Bearer ${newToken}`
        return apiClient(original)
      } catch (refreshError) {
        drainQueue(null, refreshError)
        const { useAuthStore } = await import('@/stores/auth')
        const auth = useAuthStore.getState()
        auth._clearSession()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    console.error('[api]', original?.url, error.response?.status || error.code || error.message)

    if (!original._networkRetry && isRetryableFailure(error) && !isAuthCall) {
      original._networkRetry = true
      await delay(RETRY_DELAY_MS)
      return apiClient(original)
    }

    return Promise.reject(error)
  },
)
