import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import AppSidebar from '@/components/AppSidebar/AppSidebar.jsx'
import AppHeader from '@/components/AppHeader/AppHeader.jsx'
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
    <div className={styles.shell}>
      <aside
        className={styles.aside}
        style={{ width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)' }}
      >
        <AppSidebar collapsed={collapsed} />
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <AppHeader collapsed={collapsed} onToggle={toggleSidebar} />
        </header>
        <main className={styles.content}>
          <div key={location.pathname} className={styles.fade}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
