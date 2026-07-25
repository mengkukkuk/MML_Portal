import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // App is deployed at the root of a dedicated IIS site, so assets live at /assets/...
  // (no sub-path prefix). `import.meta.env.BASE_URL` will be '/', which is what
  // createBrowserRouter's basename expects for root deployment.
  // If you ever move this back under an IIS sub-application like /scada, change to '/scada/'
  // and also update .env.local + the web.config SPA-fallback condition.
  base: '/',
  plugins: [react()],
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
      '/api': 'http://127.0.0.1:8088',
      '/ws': { target: 'ws://127.0.0.1:8088', ws: true },
    },
  },
  // TEMP: mirrors server.proxy so `vite preview` (serving the production dist/
  // build) can be soak-tested against the real backend, same as IIS ARR would
  // proxy /api. Remove after diagnosing the ACCESS_EXPIRE_MIN issue.
  preview: {
    port: 4173,
    proxy: {
      '/api': 'http://127.0.0.1:8088',
      '/ws': { target: 'ws://127.0.0.1:8088', ws: true },
    },
  },
})
