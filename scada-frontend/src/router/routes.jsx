import { lazy, Suspense } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import RequireAuth from './RequireAuth.jsx'
import AppShell from '../layouts/AppShell.jsx'

// Icon mapping from the old Vue route `meta.icon` strings (Element Plus icon
// names) to MUI icons, per-path imported — a barrel import pulls ~11k
// modules through Vite's optimizer and makes cold start take 30-60s.
// Odometer → SpeedOutlined, Cpu → MemoryOutlined, WarningFilled → WarningRounded,
// VideoPlay → PlayCircleOutlined, List → ListAltOutlined, Setting → SettingsOutlined,
// User → PersonOutlined.
import SpeedOutlined from '@mui/icons-material/SpeedOutlined'
import MemoryOutlined from '@mui/icons-material/MemoryOutlined'
import WarningRounded from '@mui/icons-material/WarningRounded'
import PlayCircleOutlined from '@mui/icons-material/PlayCircleOutlined'
import ListAltOutlined from '@mui/icons-material/ListAltOutlined'
import SettingsOutlined from '@mui/icons-material/SettingsOutlined'
import PersonOutlined from '@mui/icons-material/PersonOutlined'
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined'

const LoginPage = lazy(() => import('../pages/LoginPage.jsx'))
const ResetPasswordPage = lazy(() => import('../pages/ResetPasswordPage.jsx'))
const OverviewPage = lazy(() => import('../pages/OverviewPage.jsx'))
const DevicesPage = lazy(() => import('../pages/DevicesPage.jsx'))
const AlarmsPage = lazy(() => import('../pages/AlarmsPage.jsx'))
const LivePage = lazy(() => import('../pages/live/LivePage.jsx'))
const MonitorPage = lazy(() => import('../pages/monitor/MonitorPage.jsx'))
const EventPage = lazy(() => import('../pages/EventPage.jsx'))
const SettingsPage = lazy(() => import('../pages/SettingsPage.jsx'))
const AccountsPage = lazy(() => import('../pages/AccountsPage.jsx'))
const NotFoundPage = lazy(() => import('../pages/NotFoundPage.jsx'))

// Wraps a lazily-loaded page component in a Suspense boundary. fallback is
// intentionally null (not a spinner) — page chunks are small and this keeps
// route transitions from flashing a loading state on a fast connection.
function page(Component) {
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  )
}

export const router = createBrowserRouter(
  [
    {
      // Root guard — reproduces Vue's single global `router.beforeEach`.
      // See RequireAuth.jsx for the auth/role/login-redirect logic.
      element: <RequireAuth />,
      children: [
        { path: '/login', element: page(LoginPage), handle: { isLoginRoute: true } },
        { path: '/reset-password', element: page(ResetPasswordPage) },
        {
          path: '/',
          element: <AppShell />,
          handle: { requiresAuth: true },
          children: [
            {
              index: true,
              element: page(OverviewPage),
              handle: { title: 'Overview', icon: SpeedOutlined },
            },
            {
              path: 'devices',
              element: page(DevicesPage),
              handle: { title: 'Devices', icon: MemoryOutlined },
            },
            {
              path: 'alarms',
              element: page(AlarmsPage),
              handle: { title: 'Alarms', icon: WarningRounded },
            },
            {
              path: 'live',
              element: page(LivePage),
              handle: { title: 'Live', icon: PlayCircleOutlined },
            },
            {
              path: 'monitor',
              element: page(MonitorPage),
              handle: { title: 'Monitor', icon: AccountTreeOutlined },
            },
            {
              path: 'events',
              element: page(EventPage),
              handle: { title: 'Events', icon: ListAltOutlined },
            },
            {
              path: 'settings',
              element: page(SettingsPage),
              handle: { title: 'Settings', icon: SettingsOutlined },
            },
            {
              path: 'accounts',
              element: page(AccountsPage),
              handle: { title: 'Accounts', icon: PersonOutlined, requiresRole: 'admin' },
            },
          ],
        },
        // Catch-all — intentionally NOT nested under AppShell and carries no
        // requiresAuth handle, matching the old top-level
        // `/:pathMatch(.*)*` route (renders outside the authenticated shell,
        // reachable regardless of login state).
        { path: '*', element: page(NotFoundPage) },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL },
)
