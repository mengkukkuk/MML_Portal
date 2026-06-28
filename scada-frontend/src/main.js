import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import './styles/index.css'
import { useSettingsStore } from './stores/settings'

// Reflect the persisted theme before first paint to avoid a flash of the
// default palette. The store reads the same localStorage key.
const savedTheme = localStorage.getItem('mml.theme') || 'cobalt'
document.documentElement.dataset.theme = savedTheme

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
app.use(router)

useSettingsStore(pinia).init()
app.use(ElementPlus)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.mount('#app')
