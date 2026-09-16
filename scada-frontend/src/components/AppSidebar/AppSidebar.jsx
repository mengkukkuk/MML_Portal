import { useTranslation } from '@/i18n'
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
import MmlLogo from '@/components/MmlLogo/MmlLogo.jsx'
import styles from './AppSidebar.module.css'

// Nav items ported 1:1 from AppSidebar.vue's `items` computed
const BASE_ITEMS = [
  { path: '/monitor', title: 'Monitor', Icon: AccountTreeOutlined },
  { path: '/live', title: 'Live', Icon: PlayCircleOutlined },
  { path: '/reports', title: 'Reports', Icon: AssessmentOutlined },
  //{ path: '/ap', title: 'A&P', Icon: SpeedOutlined },
  { path: '/events', title: 'Events', Icon: ListAltOutlined },
  { path: '/alarms', title: 'Alarms', Icon: WarningRounded },
  //{ path: '/devices', title: 'Devices', Icon: MemoryOutlined },
  { path: '/settings', title: 'Settings', Icon: SettingsOutlined },
]

/**
 * AppSidebar — collapsible left navigation menu rendered inside AppShell.
 * Navigation items are role-aware: the Accounts link is only shown to admin
 * users. Props: collapsed (Boolean) — when true, hides text labels and the
 * brand title.
 */
export default function AppSidebar({ collapsed }) {
  const tr = useTranslation()
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
              aria-label={tr(item.title)}
              title={collapsed ? tr(item.title) : undefined}
              onClick={() => navigate(item.path)}
            >
              <ListItemIcon className={styles.menuIcon}>
                <item.Icon fontSize="small" />
              </ListItemIcon>
              {!collapsed && <ListItemText primary={tr(item.title)} />}
            </ListItemButton>
          )
        })}
      </List>
      <div
        className={`${styles.poweredBy} ${collapsed ? styles.poweredByCollapsed : ''}`}
        title={tr("Powered by Engineering Off-Site")}
        aria-label={collapsed ? tr("Powered by Engineering Off-Site") : undefined}
      >
        <MmlLogo className={styles.poweredLogo} orbitClassName={styles.poweredOrbit} />
        {!collapsed && (
          <div className={styles.poweredCopy}>
            <span className={styles.poweredCaption}>{tr("Powered by")}</span>
            <span className={styles.poweredName}>Engineering Off-Site</span>
          </div>
        )}
      </div>
    </div>
  )
}
