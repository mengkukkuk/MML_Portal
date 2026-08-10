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
import { useAuthStore } from '@/stores/auth'
import styles from './AppSidebar.module.css'

// Nav items ported 1:1 from AppSidebar.vue's `items` computed (Trends
// removed — Grafana/trends are gone from this branch). Accounts is
// appended only for admin users, same as the Vue version.
const BASE_ITEMS = [
  { path: '/', title: 'Overview', Icon: SpeedOutlined },
  { path: '/live', title: 'Live', Icon: PlayCircleOutlined },
  { path: '/monitor', title: 'Monitor', Icon: AccountTreeOutlined },
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

  const activeIndex = '/' + (location.pathname.split('/')[1] || '')

  const items =
    role === 'admin'
      ? [...BASE_ITEMS, { path: '/accounts', title: 'Accounts', Icon: PersonOutlined }]
      : BASE_ITEMS

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
    </div>
  )
}
