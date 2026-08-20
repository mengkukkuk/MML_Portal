import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Backend origin for the dev/preview proxies. Overridable so the app can be
// pointed at a locally-run `python main.py` on an alternate port when the
// installed NSSM `mml-api` service is holding 8088.
const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8088'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

export default defineConfig({
  // App is deployed at the root of a dedicated IIS site, so assets live at /assets/...
  // (no sub-path prefix). `import.meta.env.BASE_URL` will be '/', which is what
  // createBrowserRouter's basename expects for root deployment.
  // If you ever move this back under an IIS sub-application like /scada, change to '/scada/'
  // and also update .env.local + the web.config SPA-fallback condition.
  base: '/',
  plugins: [react()],
  // react-draggable's ESM build (used by react-grid-layout for panel drag and
  // resize) calls `if (process.env.DRAGGABLE_DEBUG) ...` on every drag start.
  // `process` doesn't exist in the browser and Vite only substitutes
  // process.env.NODE_ENV, so that line throws ReferenceError the moment a
  // handle is grabbed — silently killing Live-page layout editing in both dev
  // and the production build. Substituting the flag compiles the branch away.
  define: {
    'process.env.DRAGGABLE_DEBUG': 'false',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ['@mui/material', '@mui/icons-material', 'echarts'],
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    proxy: {
      '/api': API_TARGET,
      '/ws': { target: WS_TARGET, ws: true },
    },
  },
  // TEMP: mirrors server.proxy so `vite preview` (serving the production dist/
  // build) can be soak-tested against the real backend, same as IIS ARR would
  // proxy /api. Remove after diagnosing the ACCESS_EXPIRE_MIN issue.
  preview: {
    port: 4173,
    proxy: {
      '/api': API_TARGET,
      '/ws': { target: WS_TARGET, ws: true },
    },
  },
})
