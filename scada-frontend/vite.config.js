import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // App is deployed at the root of a dedicated IIS site, so assets live at /assets/...
  // (no sub-path prefix). `import.meta.env.BASE_URL` will be '/', which is what
  // createWebHistory(BASE_URL) in src/router/index.js expects for root deployment.
  // If you ever move this back under an IIS sub-application like /scada, change to '/scada/'
  // and also update .env.production + the web.config SPA-fallback condition.
  base: '/',
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver()],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ['element-plus/es', 'element-plus/es/locale/lang/en'],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://127.0.0.1:8088',
      '/ws': { target: 'ws://127.0.0.1:8088', ws: true },
    },
  },
})
