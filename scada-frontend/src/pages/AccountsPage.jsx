import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { useTranslation } from '@/i18n'
import UsersView from './accounts/UsersView.jsx'
import styles from './AccountsPage.module.css'

/**
 * AccountsPage — admin-only page (route: /accounts) with two views behind a toggle:
 * "Users" (account management) and "Access" (who reached this host, from the network
 * access monitor). The view lives in the URL (?view=access) so it survives a reload,
 * works with the back button, and /access can redirect straight to it. Only the active
 * view is mounted, so the Access view's polling stops when you switch to Users.
 * Role gating is enforced upstream by handle.requiresRole in router/routes.jsx.
 */

const AccessView = lazy(() => import('./accounts/AccessView.jsx'))

const VIEWS = [
  { id: 'users', label: 'Users' },
  { id: 'access', label: 'Access' },
]

export default function AccountsPage() {
  const tr = useTranslation()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'access' ? 'access' : 'users'

  function selectView(_event, next) {
    if (!next || next === view) return // exclusive group reports null on re-click
    setParams(next === 'users' ? {} : { view: next }, { replace: true })
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>{tr('Accounts')}</h1>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={view}
          onChange={selectView}
          aria-label={tr('Accounts view')}
          className={styles.toggle}
        >
          {VIEWS.map((v) => (
            <ToggleButton key={v.id} value={v.id} className={styles.toggleBtn}>
              {tr(v.label)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </header>

      {view === 'users' ? (
        <UsersView />
      ) : (
        <Suspense fallback={null}>
          <AccessView />
        </Suspense>
      )}
    </div>
  )
}
