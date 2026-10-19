import { useEffect, useState } from 'react'
import { useMatches } from 'react-router-dom'
import IconButton from '@mui/material/IconButton'
import MenuIcon from '@mui/icons-material/Menu'
import MenuOpenIcon from '@mui/icons-material/MenuOpen'
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded'
import { useTranslation } from '@/i18n'
import styles from './AppSidebar.module.css'

/**
 * SidebarHeading — the sidebar's top-left corner: the collapse toggle, the
 * current page's title (the matched route's handle.title) and the clock.
 *
 * These used to be a header bar across the whole content area. Folding them
 * into the sidebar's own top block gives that row's height back to the page.
 * Collapsed, only the toggle remains; the time is still on its tooltip.
 */
export default function SidebarHeading({ collapsed, onToggle }) {
  const tr = useTranslation()
  const matches = useMatches()
  const withTitle = [...matches].reverse().find((m) => m.handle?.title)
  const pageTitle = tr(withTitle?.handle?.title || 'MML Portal')
  const now = useNow()
  const { date, time } = formatClock(now)

  return (
    <div className={`${styles.heading} ${collapsed ? styles.headingCollapsed : ''}`}>
      <IconButton
        className={styles.toggle}
        size="small"
        aria-label={collapsed ? tr('Expand sidebar') : tr('Collapse sidebar')}
        title={collapsed ? `${pageTitle} · ${date} ${time}` : undefined}
        onClick={onToggle}
      >
        {collapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
      </IconButton>
      {!collapsed && (
        <div className={styles.headingText}>
          <h1 className={styles.pageTitle} title={pageTitle}>{pageTitle}</h1>
          <time className={styles.clock} dateTime={now.toISOString()} aria-live="off">
            <AccessTimeRounded className={styles.clockIcon} fontSize="inherit" aria-hidden="true" />
            <span>{date}</span>
            <span className={styles.clockTime}>{time}</span>
          </time>
        </div>
      )}
    </div>
  )
}

/** Browser-local time, ticking once a second; isolated so only the clock re-renders. */
function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function formatClock(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  }
}
