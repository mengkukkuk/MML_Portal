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
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('@/pages/ResetPasswordPage.vue'),
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
      {
        path: 'accounts',
        name: 'accounts',
        component: () => import('@/pages/AccountsPage.vue'),
        meta: { title: 'Accounts', icon: 'User', requiresRole: 'admin' },
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

// Run once on first navigation — try to restore session from HttpOnly cookie
let _initialized = false

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // On first load: silently try to refresh. This restores session after page reload.
  if (!_initialized) {
    _initialized = true
    if (!auth.isLoggedIn) {
      await auth.initialize() // calls /auth/refresh with cookie
    }
  }

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  // Role-gated routes (e.g. admin-only Accounts) — redirect non-matching roles home.
  if (to.meta.requiresRole && auth.role !== to.meta.requiresRole) {
    return { name: 'overview' }
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
