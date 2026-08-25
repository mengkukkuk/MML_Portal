import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import AppSidebar from '@/components/AppSidebar/AppSidebar.jsx'
import AppHeader from '@/components/AppHeader/AppHeader.jsx'
import DbStatusBanner from '@/components/DbStatusBanner/DbStatusBanner.jsx'
import LicenseStatusBanner from '@/components/LicenseStatusBanner/LicenseStatusBanner.jsx'
import styles from './AppShell.module.css'

/**
 * AppShell — authenticated application layout (used by all protected routes).
 * Renders a collapsible AppSidebar on the left, a fixed AppHeader on top,
 * and a scrollable main content area with a light fade transition on route
 * change. Sidebar collapse state is local to this layout component.
 */
export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const location = useLocation()

  function toggleSidebar() {
    setCollapsed((c) => !c)
  }

  return (
    // The unhashed `app-shell__*` classes exist so global stylesheets can reach
    // these elements — styles/print.css hides the chrome and un-scrolls the
    // content area, and CSS Module class names are hashed at build time.
    <div className={`${styles.shell} app-shell`}>
      <aside
        className={`${styles.aside} app-shell__aside`}
        style={{ width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)' }}
      >
        <AppSidebar collapsed={collapsed} />
      </aside>
      <div className={styles.main}>
        <header className={`${styles.header} app-shell__header`}>
          <AppHeader collapsed={collapsed} onToggle={toggleSidebar} />
        </header>
        <DbStatusBanner />
        <LicenseStatusBanner />
        <main className={`${styles.content} app-shell__content`}>
          <div key={location.pathname} className={styles.fade}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
