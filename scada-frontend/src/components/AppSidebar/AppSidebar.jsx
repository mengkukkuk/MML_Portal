import { useLocation, useNavigate } from 'react-router-dom'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import SpeedOutlined from '@mui/icons-material/SpeedOutlined'
import MemoryOutlined from '@mui/icons-material/MemoryOutlined'
import WarningRounded from '@mui/icons-material/WarningRounded'
import PlayCircleOutlined from '@mui/icons-material/PlayCircleOutlined'
import ListAltOutlined from '@mui/icons-material/ListAltOutlined'
import SettingsOutlined from '@mui/icons-material/SettingsOutlined'
import PersonOutlined from '@mui/icons-material/PersonOutlined'
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined'
import AssessmentOutlined from '@mui/icons-material/AssessmentOutlined'
import { useAuthStore } from '@/stores/auth'
import { useLicenseStore } from '@/stores/license'
import styles from './AppSidebar.module.css'

// Nav items ported 1:1 from AppSidebar.vue's `items` computed (Trends
// removed — Grafana/trends are gone from this branch). Accounts is
// appended only for admin users, same as the Vue version.
const BASE_ITEMS = [
  { path: '/monitor', title: 'Monitor', Icon: AccountTreeOutlined },
  { path: '/live', title: 'Live', Icon: PlayCircleOutlined },
  { path: '/reports', title: 'Reports', Icon: AssessmentOutlined },
  //{ path: '/ap', title: 'A&P', Icon: SpeedOutlined },
  { path: '/events', title: 'Events', Icon: ListAltOutlined },
  { path: '/alarms', title: 'Alarms', Icon: WarningRounded },
  { path: '/devices', title: 'Devices', Icon: MemoryOutlined },
  { path: '/settings', title: 'Settings', Icon: SettingsOutlined },
]

/**
 * AppSidebar — collapsible left navigation menu rendered inside AppShell.
 * Navigation items are role-aware: the Accounts link is only shown to admin
 * users. Props: collapsed (Boolean) — when true, hides text labels and the
 * brand title.
 */
export default function AppSidebar({ collapsed }) {
  const location = useLocation()
  const navigate = useNavigate()
  const role = useAuthStore((s) => s.user?.role ?? null)
  // Not a security boundary — the backend gate (require_entitlement("reports"))
  // is authoritative. This just avoids showing a nav entry that would 403.
  const hasReports = useLicenseStore((s) => s.hasFeature('reports'))

  const activeIndex = '/' + (location.pathname.split('/')[1] || '')

  const visibleItems = hasReports ? BASE_ITEMS : BASE_ITEMS.filter((i) => i.path !== '/reports')

  const items =
    role === 'admin'
      ? [...visibleItems, { path: '/accounts', title: 'Accounts', Icon: PersonOutlined }]
      : visibleItems

  return (
    <div className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          ⚙
        </span>
        {!collapsed && <span className={styles.title}>MML Portal</span>}
      </div>
      <List className={styles.menu} disablePadding>
        {items.map((item) => {
          const active = activeIndex === item.path
          return (
            <ListItemButton
              key={item.path}
              className={`${styles.menuItem} ${active ? styles.menuItemActive : ''}`}
              selected={active}
              onClick={() => navigate(item.path)}
            >
              <ListItemIcon className={styles.menuIcon}>
                <item.Icon fontSize="small" />
              </ListItemIcon>
              {!collapsed && <ListItemText primary={item.title} />}
            </ListItemButton>
          )
        })}
      </List>
      <div
        className={`${styles.poweredBy} ${collapsed ? styles.poweredByCollapsed : ''}`}
        title="Powered by Engineering Off-Site"
        aria-label={collapsed ? 'Powered by Engineering Off-Site' : undefined}
      >
        <svg className={styles.poweredLogo} viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <circle className={styles.poweredOrbit} cx="32" cy="32" r="27" stroke="currentColor" strokeWidth="1.5" strokeDasharray="32 10 5 10" />
          <path d="M13 41V23L19 32L25 23V41M30 41V23L36 32L42 23V41M47 23V41H53" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="round" />
          <path d="M32 5V12M32 52V59" stroke="currentColor" strokeWidth="2" />
        </svg>
        {!collapsed && (
          <div className={styles.poweredCopy}>
            <span className={styles.poweredCaption}>Powered by</span>
            <span className={styles.poweredName}>Engineering Off-Site</span>
          </div>
        )}
      </div>
    </div>
  )
}
