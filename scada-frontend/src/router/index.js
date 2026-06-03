import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/layouts/AppShell.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: AppShell,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'overview',
        component: () => import('@/pages/OverviewPage.vue'),
        meta: { title: 'Overview', icon: 'Odometer' },
      },
      {
        path: 'devices',
        name: 'devices',
        component: () => import('@/pages/DevicesPage.vue'),
        meta: { title: 'Devices', icon: 'Cpu' },
      },
      {
        path: 'alarms',
        name: 'alarms',
        component: () => import('@/pages/AlarmsPage.vue'),
        meta: { title: 'Alarms', icon: 'WarningFilled' },
      },
      {
        path: 'trends',
        name: 'trends',
        component: () => import('@/pages/TrendsPage.vue'),
        meta: { title: 'Trends', icon: 'TrendCharts' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/pages/SettingsPage.vue'),
        meta: { title: 'Settings', icon: 'Setting' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/NotFoundPage.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// Auth guard
router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // Load user profile if we have a token but no user yet
  if (auth.isLoggedIn && !auth.user) {
    await auth.loadUser()
  }

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'overview' }
  }
})

router.afterEach((to) => {
  const title = to.meta?.title
  document.title = title ? `${title} · SCADA` : 'SCADA Dashboard'
})

export default router
