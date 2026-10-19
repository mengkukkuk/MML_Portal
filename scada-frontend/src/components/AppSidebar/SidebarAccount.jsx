import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import ButtonBase from '@mui/material/ButtonBase'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListSubheader from '@mui/material/ListSubheader'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Checkbox from '@mui/material/Checkbox'
import Divider from '@mui/material/Divider'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import PersonOutlined from '@mui/icons-material/PersonOutlined'
import UnfoldMoreRounded from '@mui/icons-material/UnfoldMoreRounded'
import StorageOutlined from '@mui/icons-material/StorageOutlined'
import TranslateRounded from '@mui/icons-material/TranslateRounded'
import RefreshIcon from '@mui/icons-material/Refresh'
import KeyOutlined from '@mui/icons-material/KeyOutlined'
import LogoutRounded from '@mui/icons-material/LogoutRounded'
import { useLanguageStore, useTranslation } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { changePassword } from '@/api/auth'
import { apiErrorMessage } from '@/api/client'
import { useDatasourceSelection } from './useDatasourceSelection'
import styles from './AppSidebar.module.css'

/**
 * SidebarAccount — one compact button above the MML logo that holds what used
 * to be the right half of the header bar: the data sources being read, the
 * interface language, a page reload, and the user's own menu.
 *
 * The button itself states the two things worth seeing at a glance — who is
 * signed in and which plant is being read — and everything else waits in the
 * menu it opens, which pops out to the right of the sidebar so it never covers
 * the navigation. Data sources and language change in place, without closing
 * the menu, since picking several plants is several clicks.
 */
export default function SidebarAccount({ collapsed }) {
  const tr = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const { sources, selected, ids, implicit, toggle, isPending } = useDatasourceSelection()

  const displayName = user?.display_name || user?.username || tr('Operator')
  const sourceSummary = selected.length === 0 ? tr('No data source')
    : selected.length === 1 ? selected[0].name
      : `${selected[0].name} +${selected.length - 1}`

  const [anchorEl, setAnchorEl] = useState(null)
  const close = () => setAnchorEl(null)

  async function handleSignOut() {
    close()
    await signOut()
    navigate('/login')
  }

  // --- Change password dialog ---
  const [pwVisible, setPwVisible] = useState(false)
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const {
    register, handleSubmit, reset, watch, formState: { errors },
  } = useForm({ defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' } })

  function openChangePassword() {
    close()
    setPwError('')
    reset({ oldPassword: '', newPassword: '', confirmPassword: '' })
    setPwVisible(true)
  }

  async function submitChangePassword(values) {
    setPwError('')
    setPwLoading(true)
    try {
      await changePassword(values.oldPassword, values.newPassword)
      setPwVisible(false)
    } catch (e) {
      setPwError(apiErrorMessage(e, 'Password change failed'))
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <>
      <ButtonBase
        className={`${styles.account} ${collapsed ? styles.accountCollapsed : ''}`}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchorEl)}
        aria-label={tr('Account and data sources')}
        title={collapsed ? `${displayName} · ${sourceSummary}` : undefined}
      >
        <span className={styles.avatar}><PersonOutlined fontSize="small" /></span>
        {!collapsed && (
          <>
            <span className={styles.accountText}>
              <span className={styles.accountName}>{displayName}</span>
              <span className={styles.accountSource} data-implicit={implicit || undefined}>
                <StorageOutlined fontSize="inherit" />
                <span>{sourceSummary}</span>
              </span>
            </span>
            <UnfoldMoreRounded className={styles.accountChevron} fontSize="small" />
          </>
        )}
      </ButtonBase>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { className: styles.accountMenu } }}
      >
        <ListSubheader className={styles.menuSubheader}>
          {tr('Data sources')}
          {implicit && selected.length > 0 && (
            <span className={styles.menuNote}>{tr('(default)')}</span>
          )}
        </ListSubheader>
        {sources.length === 0 && (
          <MenuItem dense disabled>{tr('No saved connections yet.')}</MenuItem>
        )}
        {sources.map((ds) => (
          <MenuItem key={ds.id} dense disabled={isPending} onClick={() => toggle(ds.id)}>
            <Checkbox size="small" checked={ids.includes(ds.id)} className={styles.menuCheck} />
            <ListItemText
              primary={ds.name}
              secondary={`${ds.host}:${ds.port}/${ds.database}`}
              slotProps={{ secondary: { fontSize: 11 } }}
            />
          </MenuItem>
        ))}

        <Divider />
        <MenuItem dense onClick={() => setLanguage(language === 'en' ? 'th' : 'en')}>
          <ListItemIcon><TranslateRounded fontSize="small" /></ListItemIcon>
          <ListItemText primary={tr('Language')} />
          <span className={styles.langToggle} aria-label={`${tr('Language')}: EN / ไทย`}>
            <span lang="en" data-on={language === 'en' || undefined}>EN</span>
            <span aria-hidden="true">/</span>
            <span lang="th" data-on={language === 'th' || undefined}>ไทย</span>
          </span>
        </MenuItem>
        {/* A full document reload, not a refetch: the same thing F5 does, in
            reach on a panel-mounted touch screen that has no keyboard. /monitor
            installs a beforeunload guard while its drawing is dirty, and that is
            what protects unsaved work here too. */}
        <MenuItem dense onClick={() => window.location.reload()}>
          <ListItemIcon><RefreshIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={tr('Refresh page')} />
        </MenuItem>

        <Divider />
        <ListSubheader className={styles.menuSubheader}>{displayName}</ListSubheader>
        <MenuItem dense onClick={openChangePassword}>
          <ListItemIcon><KeyOutlined fontSize="small" /></ListItemIcon>
          <ListItemText primary={tr('Change password')} />
        </MenuItem>
        <MenuItem dense onClick={handleSignOut}>
          <ListItemIcon><LogoutRounded fontSize="small" /></ListItemIcon>
          <ListItemText primary={tr('Sign out')} />
        </MenuItem>
      </Menu>

      <Dialog open={pwVisible} onClose={() => setPwVisible(false)} fullWidth maxWidth="xs">
        <DialogTitle>{tr('Change password')}</DialogTitle>
        <form onSubmit={handleSubmit(submitChangePassword)}>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
            <TextField
              label={tr('Current password')}
              type="password"
              autoComplete="current-password"
              fullWidth
              {...register('oldPassword', { required: true })}
            />
            <TextField
              label={tr('New password')}
              type="password"
              placeholder={tr('At least 8 characters')}
              autoComplete="new-password"
              fullWidth
              error={!!errors.newPassword}
              helperText={errors.newPassword ? tr('New password must be at least 8 characters') : ' '}
              {...register('newPassword', { required: true, minLength: 8 })}
            />
            <TextField
              label={tr('Confirm new password')}
              type="password"
              autoComplete="new-password"
              fullWidth
              error={!!errors.confirmPassword}
              helperText={errors.confirmPassword ? tr('Passwords do not match') : ' '}
              {...register('confirmPassword', {
                validate: (value) => value === watch('newPassword') || 'Passwords do not match',
              })}
            />
            {pwError && <Alert severity="error">{tr(pwError)}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPwVisible(false)}>{tr('Cancel')}</Button>
            <Button type="submit" variant="contained" disabled={pwLoading}>{tr('Change password')}</Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  )
}
